/**
 * 冷库读端：把 billion-context 原文库吸进来之后（tools/absorb-billion-context.mjs），
 * 需要一个能按「会话 + seq 区间」取回一段原文的入口，给 bh_restore_span 用。
 *
 * 格式约定（与吸收脚本一致）：
 *   <root>/manifest.jsonl                       一行一片
 *   <root>/<session>/<四位序号>-<a>-<b>.md.br   brotli 压缩的 Markdown
 *
 * 读的时候逐片校验 sha256：宁可报 E_CORRUPT，也不吐出对不上号的内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export class ColdStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ColdStoreError';
    this.code = code;
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 从一片 Markdown 里切出消息块：`## [seq N] role/kind` 开头，正文到下一个标题前。 */
function parseMessages(markdown) {
  const out = [];
  const re = /^## \[seq (\d+)\] ([^\n/]+)\/([^\n]+)\n\n/gm;
  const hits = [];
  let m;
  while ((m = re.exec(markdown)) !== null) {
    hits.push({ seq: Number(m[1]), role: m[2].trim(), kind: m[3].trim(), start: re.lastIndex });
  }
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start - `## [seq ${hits[i + 1].seq}] ${hits[i + 1].role}/${hits[i + 1].kind}\n\n`.length : markdown.length;
    out.push({ seq: hits[i].seq, role: hits[i].role, kind: hits[i].kind, text: markdown.slice(hits[i].start, end).replace(/\n$/, '') });
  }
  return out;
}

export class ColdStore {
  constructor({ root } = {}) {
    if (!root) throw new ColdStoreError('E_NO_ROOT', '冷库目录没配置（coldStoreRoot）');
    this.root = root;
    this._manifest = null;
  }

  manifestPath() {
    return path.join(this.root, 'manifest.jsonl');
  }

  manifest() {
    if (this._manifest) return this._manifest;
    const file = this.manifestPath();
    if (!fs.existsSync(file)) throw new ColdStoreError('E_NO_MANIFEST', `冷库没有 manifest：${file}`);
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    this._manifest = rows;
    return rows;
  }

  /** 会话清单：每个会话几片、多少消息、占多少字节。 */
  sessions() {
    const bySession = new Map();
    for (const row of this.manifest()) {
      const cur = bySession.get(row.session) ?? { session: row.session, parts: 0, messages: 0, storedBytes: 0, seqFrom: Infinity, seqTo: -Infinity };
      cur.parts += 1;
      cur.messages += row.messages ?? 0;
      cur.storedBytes += row.storedBytes ?? 0;
      cur.seqFrom = Math.min(cur.seqFrom, row.seqFrom);
      cur.seqTo = Math.max(cur.seqTo, row.seqTo);
      bySession.set(row.session, cur);
    }
    return [...bySession.values()].sort((a, b) => b.storedBytes - a.storedBytes);
  }

  /** 按完整 id 或唯一前缀解析会话；精确命中优先，歧义时报 E_AMBIGUOUS。 */
  resolveSession(idOrPrefix) {
    const all = [...new Set(this.manifest().map((row) => row.session))];
    if (all.includes(idOrPrefix)) return idOrPrefix;
    const hits = all.filter((s) => s.startsWith(idOrPrefix));
    if (hits.length === 0) throw new ColdStoreError('E_NO_SESSION', `冷库里没有这个会话：${idOrPrefix}`);
    if (hits.length > 1) {
      throw new ColdStoreError('E_AMBIGUOUS', `前缀命中 ${hits.length} 个会话，给完整 id：\n${hits.join('\n')}`);
    }
    return hits[0];
  }

  /** 取回 [from, to] 区间内的消息（含端点）；逐片校验 sha256。 */
  readSpan({ session, from, to = from, maxChars = 0 }) {
    const id = this.resolveSession(String(session));
    const lo = Math.min(Number(from), Number(to));
    const hi = Math.max(Number(from), Number(to));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new ColdStoreError('E_BAD_RANGE', 'from / to 必须是数字');

    const rows = this.manifest().filter((row) => row.session === id && row.seqTo >= lo && row.seqFrom <= hi);
    if (rows.length === 0) throw new ColdStoreError('E_NOT_FOUND', `区间没命中任何分片：${id} ${lo}-${hi}`);

    const messages = [];
    let scanned = 0;
    let truncated = false;
    for (const row of rows) {
      scanned += 1;
      const raw = zlib.brotliDecompressSync(fs.readFileSync(path.join(this.root, row.file)));
      if (sha256(raw) !== row.sha256) throw new ColdStoreError('E_CORRUPT', `分片校验失败：${row.file}`);
      for (const msg of parseMessages(raw.toString('utf8'))) {
        if (msg.seq < lo || msg.seq > hi) continue;
        messages.push(msg);
        if (maxChars > 0 && messages.reduce((n, m) => n + m.text.length, 0) >= maxChars) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    messages.sort((a, b) => a.seq - b.seq);
    // digest（2026-11-08 09:2x，书同文评测要的）：召回内容逐字可比、又不用两边重算整段。
    // 口径固定成「按 seq 升序，每条 seq + 换行 + 正文，拼起来再 sha256」，
    // 消费方照这个口径算出来相等就算逐字一致；不相等就是改写/幻觉。
    const canonical = messages.map((m) => `${m.seq}\n${m.text}`).join('');
    const bytes = Buffer.byteLength(canonical, 'utf8');
    const digest = `sha256:${sha256(Buffer.from(canonical, 'utf8'))}`;
    return { session: id, from: lo, to: hi, messages, scanned, truncated, bytes, digest, digestRule: 'sha256(seq + "\\n" + text, 按 seq 升序拼接)' };
    return { session: id, from: lo, to: hi, messages, scanned, truncated, bytes, digest, digestRule: 'sha256(seq + "\\n" + text, 按 seq 升序拼接)' };
  }
}

