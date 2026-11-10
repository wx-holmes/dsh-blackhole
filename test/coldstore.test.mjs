/**
 * 冷库读端测试：造一个迷你冷库，验「按 seq 取回 / 逐片校验 / 前缀歧义 / 损坏」四条。
 * 不碰真实冷库：全部在 os.tmpdir() 里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { ColdStore, ColdStoreError } from '../src/coldstore.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cold-'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const manifest = [];

function writePart(session, file, seqFrom, seqTo, rows) {
  const head = `---\nsession: ${session}\nseq: ${seqFrom}-${seqTo}\nmessages: ${rows.length}\n---\n\n`;
  const body = rows.map((r) => `## [seq ${r.seq}] ${r.role}/${r.kind}\n\n${r.text}\n`).join('\n');
  const raw = Buffer.from(head + body, 'utf8');
  const abs = path.join(dir, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, zlib.brotliCompressSync(raw));
  const row = { session, seqFrom, seqTo, messages: rows.length, rawBytes: raw.length, storedBytes: 1, file, sha256: sha256(raw) };
  manifest.push(row);
  return row;
}

const session = 'session-test-aaaa';
const other = 'session-test-bbbb';
writePart(session, `${session}/0000-0-1.md.br`, 0, 1, [
  { seq: 0, role: 'user', kind: 'text', text: '第一句' },
  { seq: 1, role: 'assistant', kind: 'text', text: '第二句' },
]);
const second = writePart(session, `${session}/0001-2-3.md.br`, 2, 3, [
  { seq: 2, role: 'user', kind: 'text', text: '第三句' },
  { seq: 3, role: 'assistant', kind: 'text', text: '第四句' },
]);
writePart(other, `${other}/0000-0-0.md.br`, 0, 0, [{ seq: 0, role: 'user', kind: 'text', text: '别的会话' }]);
fs.writeFileSync(path.join(dir, 'manifest.jsonl'), manifest.map((p) => JSON.stringify(p)).join('\n') + '\n');

const checks = [];
const ok = (name, cond, extra = '') => checks.push({ name, pass: Boolean(cond), extra });

try {
  const store = new ColdStore({ root: dir });
  ok('sessions 列出 2 个会话', store.sessions().length === 2, JSON.stringify(store.sessions().map((s) => s.session)));
  ok('sessions 统计 4 条消息', store.sessions().find((s) => s.session === session)?.messages === 4);

  const span = store.readSpan({ session, from: 1, to: 2 });
  ok('跨片取回 2 条', span.messages.length === 2, JSON.stringify(span.messages.map((m) => m.seq)));
  ok('顺序是 1,2', span.messages.map((m) => m.seq).join(',') === '1,2');
  ok('正文完整', span.messages[1].text.trim() === '第三句', JSON.stringify(span.messages[1].text));
  ok('扫过 2 片', span.scanned === 2);

  const single = store.readSpan({ session, from: 3 });
  ok('单点取回（to 省略）', single.messages.length === 1 && single.messages[0].seq === 3);

  let exactPrefix = null;
  try { exactPrefix = store.readSpan({ session: 'session-test-aaaa', from: 0, to: 1 }); } catch (e) { exactPrefix = e; }
  ok('完整 id 精确命中不歧义', Array.isArray(exactPrefix?.messages) && exactPrefix.messages.length === 2);

  let ambiguous = null;
  try { store.readSpan({ session: 'session-test', from: 0 }); } catch (e) { ambiguous = e; }
  ok('歧义前缀报 E_AMBIGUOUS', ambiguous instanceof ColdStoreError && ambiguous.code === 'E_AMBIGUOUS', String(ambiguous?.code));

  let unknown = null;
  try { store.readSpan({ session: 'nope', from: 0 }); } catch (e) { unknown = e; }
  ok('不存在的会话报 E_NO_SESSION', unknown instanceof ColdStoreError && unknown.code === 'E_NO_SESSION');

  let missing = null;
  try { store.readSpan({ session, from: 99 }); } catch (e) { missing = e; }
  ok('越界报 E_NOT_FOUND', missing instanceof ColdStoreError && missing.code === 'E_NOT_FOUND');

  // 篡改一片：校验必须拦住
  fs.writeFileSync(path.join(dir, second.file), zlib.brotliCompressSync(Buffer.from('---\nsession: x\n---\n\n## [seq 2] user/text\n\n伪造\n')));
  let corrupt = null;
  try { store.readSpan({ session, from: 2, to: 2 }); } catch (e) { corrupt = e; }
  ok('篡改后报 E_CORRUPT', corrupt instanceof ColdStoreError && corrupt.code === 'E_CORRUPT', String(corrupt?.message));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  ' + c.extra}`);
console.log(`coldstore: ${checks.length - failed.length}/${checks.length} pass`);
process.exit(failed.length === 0 ? 0 : 1);
