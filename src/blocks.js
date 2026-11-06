/**
 * 黑洞的原文块仓库（A 段：把「压缩 / 找回 / 搜索」这三件事收到自己手里）。
 *
 * 设计来自对 billion-context（bili，0.1.212，MIT 以外许可见其包内声明）行为的观察：
 * 它把原文存起来、只把摘要回给模型、再用 id 把原文取回。这里不搬它的代码，
 * 只借「原文可逆 + 摘要占位」这个思路，用自己的目录结构、自己的 id、自己的错误处理重写。
 *
 * 与 bili 的关键差异（吸收后要更强的地方）：
 *   - id 由内容哈希决定（同一段内容重复压缩只落一份，天然幂等）
 *   - 摘要器默认是「抽取式」，不依赖 llm 服务；llm 在时可由调用方传入更短的摘要
 *   - 每条块带来源（source）与标签（tags），可按来源筛
 *   - 索引是 append-only JSONL，坏一行不影响其余（bili 是整库单文件）
 *   - 所有失败都有明确 code，不抛裸异常给工具层
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BLOCK_ID_PREFIX = 'bhb';
export const DEFAULT_SUMMARY_CHARS = 360;
export const DEFAULT_READ_LIMIT = 20000;

const ID_RE = /^bhb_[0-9]{8}_[0-9a-f]{8}$/;

export class BlockStoreError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'BlockStoreError';
    this.code = code;
    this.detail = detail;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function dayStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/**
 * 抽取式摘要：不调模型，按「标题行 → 小标题 → 每段首句」取，最后按字数封顶。
 * 它不如模型摘要精炼，但永远不会因为「模型不给文本 / 摘要比原文长」而失败——
 * 这正是 bili 那套的失败模式（archive.failed 的第一大原因）。
 */
export function extractiveSummary(text, maxChars = DEFAULT_SUMMARY_CHARS) {
  const source = String(text ?? '');
  if (!source.trim()) return '';
  const lines = source.split(/\r?\n/);
  const picked = [];
  let used = 0;
  const push = (line) => {
    const s = line.trim();
    if (!s) return;
    if (used >= maxChars) return;
    const room = maxChars - used;
    const piece = s.length > room ? s.slice(0, room) : s;
    picked.push(piece);
    used += piece.length + 1;
  };

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) push(line);
    if (picked.length >= 8) break;
  }
  for (const block of source.split(/\r?\n\s*\r?\n/)) {
    const first = block.split(/\r?\n/).find((l) => l.trim());
    if (first) push(first);
    if (used >= maxChars) break;
  }
  if (!picked.length) push(source);
  return picked.join('\n').slice(0, maxChars);
}

function splitTags(tags) {
  if (!tags) return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(/[,，\s]+/);
  return list.map((t) => String(t).trim()).filter(Boolean).slice(0, 16);
}

function tokenize(query) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const parts = q.split(/[\s,，、;；:：/|]+/).filter(Boolean);
  const out = new Set(parts);
  // 中文没有空格：整串也算一个 token，避免「一句话」被拆成一个字也命中不了
  out.add(q);
  return [...out].filter((t) => t.length > 0).slice(0, 24);
}

export class BlockStore {
  constructor({ stateRoot, blocksRoot, now = () => new Date() } = {}) {
    const root = blocksRoot || (stateRoot ? path.join(stateRoot, 'blocks') : '');
    if (!root) throw new BlockStoreError('E_NO_ROOT', 'BlockStore 需要 stateRoot 或 blocksRoot');
    this.root = root;
    this.now = now;
  }

  get indexPath() {
    return path.join(this.root, 'index.jsonl');
  }

  ensure() {
    fs.mkdirSync(this.root, { recursive: true });
  }

  fileFor(id) {
    if (!ID_RE.test(String(id ?? ''))) {
      throw new BlockStoreError('E_BAD_ID', `不是合法的块 id：${id}`);
    }
    return path.join(this.root, `${id}.md`);
  }

  metaFor(id) {
    return path.join(this.root, `${id}.json`);
  }

  /**
   * 写入一块原文并返回摘要句柄。
   * @returns {{id:string,path:string,summary:string,bytes:number,chars:number,deduped:boolean,createdAt:string}}
   */
  put({ content, title = '', summary = '', source = '', tags = [], maxSummaryChars = DEFAULT_SUMMARY_CHARS } = {}) {
    const text = String(content ?? '');
    if (!text.trim()) throw new BlockStoreError('E_EMPTY', 'content 为空，没什么可压的');
    this.ensure();

    const hash = sha256(text);
    const created = this.now();
    const id = `${BLOCK_ID_PREFIX}_${dayStamp(created)}_${hash.slice(0, 8)}`;
    const file = this.fileFor(id);

    if (fs.existsSync(file) && fs.existsSync(this.metaFor(id))) {
      const meta = this.readMeta(id);
      return { ...meta, deduped: true };
    }

    const effectiveSummary = String(summary ?? '').trim() || extractiveSummary(text, maxSummaryChars);
    const meta = {
      id,
      title: String(title ?? '').trim() || firstLine(text),
      summary: effectiveSummary,
      bytes: Buffer.byteLength(text, 'utf8'),
      chars: text.length,
      hash,
      source: String(source ?? '').trim(),
      tags: splitTags(tags),
      createdAt: created.toISOString(),
      path: file,
    };

    fs.writeFileSync(file, text, 'utf8');
    fs.writeFileSync(this.metaFor(id), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    fs.appendFileSync(this.indexPath, `${JSON.stringify(meta)}\n`, 'utf8');
    return { ...meta, deduped: false };
  }

  readMeta(id) {
    this.fileFor(id); // 先校验 id：非法 id 不许拼出仓外的路径
    const file = this.metaFor(id);
    if (!fs.existsSync(file)) {
      throw new BlockStoreError('E_NOT_FOUND', `没有这个块：${id}`, { id });
    }
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new BlockStoreError('E_BAD_META', `块的元数据损坏：${id}`, { id, cause: String(error?.message ?? error) });
    }
  }

  /** 取回原文，可分段读（offset/limit 按字符）。 */
  read(id, { offset = 0, limit = DEFAULT_READ_LIMIT } = {}) {
    this.readMeta(id);
    const file = this.fileFor(id);
    const text = fs.readFileSync(file, 'utf8');
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.max(1, Number(limit) || DEFAULT_READ_LIMIT);
    return {
      id,
      text: text.slice(start, start + size),
      offset: start,
      limit: size,
      chars: text.length,
      truncated: start + size < text.length,
    };
  }

  /** 读索引（坏行跳过并计数）。 */
  readIndex() {
    if (!fs.existsSync(this.indexPath)) return { rows: [], broken: 0 };
    const rows = [];
    let broken = 0;
    for (const line of fs.readFileSync(this.indexPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        broken += 1;
      }
    }
    return { rows, broken };
  }

  /**
   * 关键词搜索：标题 3 分、摘要 2 分、标签 1 分；`full` 时再扫原文。
   * 不依赖任何外部索引服务，块少的时候比建全文索引更稳。
   */
  search(query, { limit = 8, full = false, source = '' } = {}) {
    const tokens = tokenize(query);
    if (!tokens.length) throw new BlockStoreError('E_EMPTY_QUERY', 'query 为空');
    const { rows } = this.readIndex();
    const hits = [];
    for (const row of rows) {
      if (source && row.source !== source) continue;
      const title = String(row.title ?? '');
      const summary = String(row.summary ?? '');
      const tags = Array.isArray(row.tags) ? row.tags.join(' ') : '';
      let score = 0;
      for (const token of tokens) {
        if (title.includes(token)) score += 3;
        if (summary.includes(token)) score += 2;
        if (tags.includes(token)) score += 1;
      }
      let bodyHit = false;
      if (full && score === 0) {
        try {
          const text = fs.readFileSync(this.fileFor(row.id), 'utf8');
          bodyHit = tokens.some((token) => text.includes(token));
          if (bodyHit) score = 1;
        } catch {
          /* 原文丢了不影响其余结果 */
        }
      }
      if (score > 0) hits.push({ ...row, score, snippet: snippetOf(summary, tokens), bodyHit });
    }
    hits.sort((a, b) => b.score - a.score || String(b.createdAt).localeCompare(String(a.createdAt)));
    return hits.slice(0, Math.max(1, Number(limit) || 8));
  }

  status() {
    const { rows, broken } = this.readIndex();
    let bytes = 0;
    let missing = 0;
    for (const row of rows) {
      try {
        bytes += fs.statSync(this.fileFor(row.id)).size;
      } catch {
        missing += 1;
      }
    }
    const recent = [...rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5);
    return { root: this.root, blocks: rows.length, bytes, missing, brokenIndexLines: broken, recent };
  }
}

function firstLine(text) {
  const line = String(text).split(/\r?\n/).find((l) => l.trim());
  return (line ?? '').trim().slice(0, 60);
}

function snippetOf(summary, tokens) {
  const text = String(summary ?? '');
  for (const token of tokens) {
    const at = text.indexOf(token);
    if (at >= 0) {
      const start = Math.max(0, at - 24);
      return text.slice(start, start + 120).replace(/\s+/g, ' ').trim();
    }
  }
  return text.slice(0, 120).replace(/\s+/g, ' ').trim();
}
