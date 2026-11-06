/**
 * 原文块仓单测（A 段，2026-11-06）。
 *
 * 这一层是「吸收 bili 而不是照抄」的地基：原文按内容哈希落盘、只追加索引、
 * 摘要自己抽（不调模型）、失败都有 code。测试盯住七件事：
 *   1. put 落三份（<id>.md / <id>.json / index.jsonl），id 形如 bhb_YYYYMMDD_xxxxxxxx；
 *   2. 同内容重复 put 去重（deduped:true，索引不涨，原文不覆盖）；
 *   3. 空内容抛 E_EMPTY；非法 id 抛 E_BAD_ID；块不存在抛 E_NOT_FOUND；元数据坏了抛 E_BAD_META；
 *   4. read 的 offset/limit/truncated 正确（按字符，按 UTF-8 写盘）；
 *   5. search 计分：标题 > 摘要 > 标签，full 时能扫到正文；source 可筛；
 *   6. readIndex 坏行跳过并计数，不整库报废；
 *   7. status 的块数/字节/丢原件数/最近几块。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlockStore, extractiveSummary, dayStamp, BLOCK_ID_PREFIX } from '../src/blocks.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}
function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bh-blocks-${tag}-`));
}

// 1. put 落三份 + id 格式
{
  const root = tmpRoot('put');
  const store = new BlockStore({ blocksRoot: root, now: () => new Date('2026-11-06T01:02:03+08:00') });
  const meta = store.put({ content: '# 标题\n\n第一段正文。\n\n第二段正文。', title: '测试块', source: 'unit', tags: ['alpha', 'beta'] });
  assert.equal(meta.deduped, false);
  assert.equal(meta.id, `${BLOCK_ID_PREFIX}_20261106_${meta.hash.slice(0, 8)}`);
  assert.match(meta.id, /^bhb_[0-9]{8}_[0-9a-f]{8}$/);
  assert.ok(fs.existsSync(path.join(root, `${meta.id}.md`)));
  assert.ok(fs.existsSync(path.join(root, `${meta.id}.json`)));
  const lines = fs.readFileSync(path.join(root, 'index.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id, meta.id);
  assert.deepEqual(meta.tags, ['alpha', 'beta']);
  ok('put 落三份、id 形如 bhb_YYYYMMDD_xxxxxxxx、索引一行');
}

// 2. 去重
{
  const root = tmpRoot('dedupe');
  const store = new BlockStore({ blocksRoot: root });
  const a = store.put({ content: '同一段内容', title: 'A' });
  const b = store.put({ content: '同一段内容', title: 'B' });
  assert.equal(b.id, a.id);
  assert.equal(b.deduped, true);
  assert.equal(b.title, 'A'); // 保留第一次的元数据
  const lines = fs.readFileSync(path.join(root, 'index.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, '去重不应追加索引');
  ok('同内容去重（deduped:true、索引不涨、原文不覆盖）');
}

// 3. 错误码
{
  const root = tmpRoot('errors');
  const store = new BlockStore({ blocksRoot: root });
  assert.throws(() => store.put({ content: '   ' }), (e) => e.code === 'E_EMPTY');
  assert.throws(() => store.fileFor('not-an-id'), (e) => e.code === 'E_BAD_ID');
  assert.throws(() => store.readMeta('bhb_20260101_deadbeef'), (e) => e.code === 'E_NOT_FOUND');
  assert.throws(() => store.read('bhb_20260101_deadbeef'), (e) => e.code === 'E_NOT_FOUND');
  const m = store.put({ content: '元数据会坏' });
  fs.writeFileSync(path.join(root, `${m.id}.json`), '{ 坏掉的 json');
  assert.throws(() => store.readMeta(m.id), (e) => e.code === 'E_BAD_META');
  assert.throws(() => new BlockStore({}), (e) => e.code === 'E_NO_ROOT');
  ok('错误码齐：E_EMPTY / E_BAD_ID / E_NOT_FOUND / E_BAD_META / E_NO_ROOT');
}

// 4. 分段读
{
  const root = tmpRoot('read');
  const store = new BlockStore({ blocksRoot: root });
  const content = '零一二三四五六七八九十';
  const m = store.put({ content });
  const head = store.read(m.id, { offset: 0, limit: 3 });
  assert.equal(head.text, '零一二');
  assert.equal(head.chars, content.length);
  assert.equal(head.truncated, true);
  const tail = store.read(m.id, { offset: 3, limit: 100 });
  assert.equal(tail.text, '三四五六七八九十');
  assert.equal(tail.truncated, false);
  ok('read 的 offset/limit/truncated 正确');
}

// 5. 搜索计分与 full
{
  const root = tmpRoot('search');
  const store = new BlockStore({ blocksRoot: root });
  const titleHit = store.put({ content: '正文里没有那个词', title: '黑洞压缩' });
  const summaryHit = store.put({ content: '正文 ', summary: '提到黑洞的一段摘要', title: '别的' });
  const tagHit = store.put({ content: '正文 ', title: '再别的', tags: ['黑洞'] });
  const bodyOnly = store.put({ content: '这一段正文深处写着黑洞两个字', summary: '与关键词无关的摘要', title: '正文块' });

  const hits = store.search('黑洞');
  const ids = hits.map((h) => h.id);
  assert.equal(ids[0], titleHit.id, '标题命中排最前');
  assert.ok(ids.includes(summaryHit.id) && ids.includes(tagHit.id));
  assert.ok(!ids.includes(bodyOnly.id), '不扫正文时正文块不该命中');

  const fullHits = store.search('黑洞', { full: true });
  assert.ok(fullHits.map((h) => h.id).includes(bodyOnly.id), 'full=true 时扫正文');
  assert.ok(fullHits.find((h) => h.id === bodyOnly.id).bodyHit);

  const bySource = store.search('黑洞', { source: 'nobody' });
  assert.equal(bySource.length, 0, 'source 筛掉全部');
  assert.throws(() => store.search('  '), (e) => e.code === 'E_EMPTY_QUERY');
  ok('search 计分（标题>摘要>标签）、full 扫正文、source 可筛、空 query 报 E_EMPTY_QUERY');
}

// 6. 坏索引行
{
  const root = tmpRoot('index');
  const store = new BlockStore({ blocksRoot: root });
  store.put({ content: '一' });
  fs.appendFileSync(path.join(root, 'index.jsonl'), '{ 这不是 json\n');
  fs.appendFileSync(path.join(root, 'index.jsonl'), '\n');
  store.put({ content: '二' });
  const { rows, broken } = store.readIndex();
  assert.equal(rows.length, 2);
  assert.equal(broken, 1);
  ok('readIndex 坏行跳过并计数（不整库报废）');
}

// 7. status
{
  const root = tmpRoot('status');
  const store = new BlockStore({ blocksRoot: root });
  const a = store.put({ content: '甲'.repeat(10) });
  store.put({ content: '乙' });
  fs.unlinkSync(path.join(root, `${a.id}.md`)); // 模拟原文丢失
  const s = store.status();
  assert.equal(s.blocks, 2);
  assert.equal(s.missing, 1);
  assert.ok(s.bytes > 0);
  assert.equal(s.brokenIndexLines, 0);
  assert.equal(s.recent.length, 2);
  assert.equal(s.root, root);
  ok('status 的块数/字节/丢原件数/最近几块');
}

// 8. 摘要器与日期戳（纯函数）
{
  const text = '# 一\n\n甲段第一句。甲段第二句。\n\n# 二\n\n乙段第一句。';
  const summary = extractiveSummary(text, 200);
  assert.ok(summary.includes('# 一') && summary.includes('# 二'), '标题行进摘要');
  assert.ok(summary.length <= 200);
  assert.equal(extractiveSummary('', 100), '');
  assert.equal(extractiveSummary('   ', 100), '');
  assert.match(dayStamp(new Date('2026-01-02T23:00:00+08:00')), /^\d{8}$/);
  const auto = new BlockStore({ blocksRoot: tmpRoot('summary') }).put({ content: '没有标题\n\n只有一段正文。' });
  assert.ok(auto.summary.length > 0, '不传 summary 时自动抽取');
  assert.equal(auto.title, '没有标题', '不传 title 时取首行');
  ok('extractiveSummary 取标题/首句并封顶；title/summary 缺省时自动生成');
}

console.log(`\n通过 ${passed} 项`);
