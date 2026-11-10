import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendCardIndex, buildCard, deriveRationale, deriveSummary } from '../src/cards.js';

/**
 * 2026-11-10 02:2x：卡片补「为什么 + 回取指针」的验收。
 * 背景：书同文报「29 次压缩后只剩做事、快点、完成」——卡片只记了做过什么，没记为什么。
 * 这里测的是规则抽取（不调模型、不改写原话）。
 */

const results = [];
const ev = (seq, type, text, extra = []) => ({
  seq,
  type,
  data: { message: { role: type.startsWith('user') ? 'user' : 'assistant', content: [{ type: 'text', text }, ...extra] } },
});

// 1) 抽得到「为什么」：带因果词的原话
const events = [
  ev(1, 'user/message', '这个 bug 先别改，先看清原因'),
  ev(2, 'assistant/message', '我先不动手，因为上次改错方向反而把问题弄大了。'),
  ev(3, 'assistant/message', '我选了先读日志而不是直接改代码，宁可多花五分钟。', [{ type: 'tool-call', name: 'read_file', arguments: {} }]),
  ev(4, 'user/message', '行'),
];
const why = deriveRationale(events);
assert.ok(why.includes('因为'), `应该抽到「因为」那句，实际：${why}`);
assert.ok(why.includes('而不是'), `应该抽到取舍那句，实际：${why}`);
assert.ok(why.split('｜').length <= 2, '最多两条，别把卡片撑大');
results.push('PASS  抽得到决策依据（因为/而不是），且最多两条');

// 2) 抽不到就空着，不编
const plain = [ev(1, 'user/message', '你好'), ev(2, 'assistant/message', '在的')];
assert.equal(deriveRationale(plain), '');
assert.ok(!deriveSummary(plain).includes('为什么'));
results.push('PASS  没有因果句时留空，不硬凑');

// 3) 摘要里带上「为什么」
const summary = deriveSummary(events);
assert.ok(summary.includes('为什么：'), `摘要应含为什么：${summary}`);
assert.ok(summary.includes('起点：') && summary.includes('收尾：'));
results.push('PASS  摘要 = 起点/收尾/工具/为什么');

// 4) 卡片带 rationale + pointer
const card = buildCard({
  sid: 'session-test',
  date: '2026-11-10',
  events,
  archivePath: 'A:/tmp/x.jsonl',
  now: () => new Date('2026-11-10T02:30:00Z'),
});
assert.equal(card.pointer.session, 'session-test');
assert.deepEqual([card.pointer.seqFrom, card.pointer.seqTo], [1, 4]);
assert.equal(card.pointer.how, 'bh_restore_span');
assert.ok(card.rationale.length > 0);
results.push('PASS  卡片带 rationale 与回取指针（seq 区间 + 取回方式）');

// 5) 索引：新表头 5 列、老表头 4 列都写得进去
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cards-'));
appendCardIndex({ archiveRoot: dir, card });
const md = fs.readFileSync(path.join(dir, '索引.md'), 'utf8');
assert.ok(md.includes('| 为什么 |'), '新索引应有为什么列');
const row = md.trim().split('\n').at(-1);
assert.equal(row.split('|').length - 2, 5, `新行应为 5 列：${row}`);

const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cards-old-'));
fs.writeFileSync(
  path.join(legacy, '索引.md'),
  ['# 上下文索引', '', '| 日期 | 标题 | 区间 | 原文 |', '|---|---|---|---|', ''].join('\n'),
  'utf8'
);
appendCardIndex({ archiveRoot: legacy, card });
const oldRow = fs.readFileSync(path.join(legacy, '索引.md'), 'utf8').trim().split('\n').at(-1);
assert.equal(oldRow.split('|').length - 2, 4, `老表头应继续写 4 列：${oldRow}`);
results.push('PASS  索引兼容：新表头 5 列、老表头 4 列');

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(legacy, { recursive: true, force: true });

console.log(results.join('\n'));
console.log(`\ncards: ${results.length}/${results.length} pass`);
