import assert from 'node:assert/strict';
import { buildCard, deriveTags, deriveTitle, deriveSummary } from '../src/cards.js';
import { HORIZON_DEFAULTS, density, level, recallBufferBudget, resolveHorizon, shouldArchive, usableWindow } from '../src/horizon.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

const EVENTS = [
  {
    seq: 12,
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: '把归档写进 self，路径用 A:\\tongwen\\self\\context。' }] } },
  },
  {
    seq: 13,
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '好，先读 session 事件再落盘。' },
          { type: 'tool-call', name: 'read_file', arguments: { path: 'A:\\x.md' } },
        ],
      },
    },
  },
  {
    seq: 14,
    type: 'tool/result',
    data: { message: { role: 'tool', content: [{ type: 'text', text: '原始输出 12345' }] } },
  },
];

console.log('U2b 纯逻辑 · 单测');

// ---- horizon ----
assert.equal(usableWindow(1000, { outputReserve: 100, headroom: 50 }), 850);
assert.equal(usableWindow(10, { outputReserve: 100, headroom: 100 }), 1, '可用窗口至少 1');
ok('可用窗口 = 窗口 − 输出预留 − 余量');

assert.equal(density(600, 1000), 0.6);
ok('density 计算');

assert.equal(level(0.59), 'normal');
assert.equal(level(0.6), 'archive');
assert.equal(level(0.74), 'archive');
assert.equal(level(0.75), 'solidify');
assert.equal(level(0.89), 'solidify');
assert.equal(level(0.9), 'hardcap');
ok('档位边界：0.59 normal / 0.60 archive / 0.75 solidify / 0.90 hardcap');

assert.equal(shouldArchive(0.6), true);
assert.equal(shouldArchive(0.59), false);
ok('shouldArchive 与档位一致');

assert.equal(recallBufferBudget(400, 0.69), 400);
assert.equal(recallBufferBudget(400, 0.7), 0);
ok('回溯缓冲区：水位 ≥0.70 降为 0（只留指针）');

assert.throws(() => resolveHorizon({ eventHorizon: 0.8, solidifyLine: 0.7 }), /eventHorizon/);
assert.throws(() => resolveHorizon({ hardCap: 1.2 }), /hardCap/);
assert.deepEqual(resolveHorizon({ eventHorizon: 0.55 }).eventHorizon, 0.55);
ok('配置校验：顺序与范围');

// ---- cards ----
const card = buildCard({
  sid: 'session-test-1',
  date: '2026-11-05',
  events: EVENTS,
  archivePath: 'A:\\tongwen\\self\\context\\session-test-1\\2026-11-05\\12-14.md',
  now: () => new Date('2026-11-05T07:25:00Z'),
});
assert.match(card.cardId, /^bh_20261105_[0-9a-f]{8}$/);
assert.equal(card.range[0], 12);
assert.equal(card.range[1], 14);
assert.equal(card.events, 3);
assert.equal(card.tier, 'hot');
assert.equal(card.supersededBy, null);
assert.ok(card.src.includes('12-14.md'));
ok('卡字段：cardId/range/events/src/tier');

assert.equal(deriveTitle(EVENTS).startsWith('把归档写进 self'), true);
ok('标题取第一条用户消息');

const summary = deriveSummary(EVENTS);
assert.ok(summary.includes('起点：'));
assert.ok(summary.includes('收尾：'));
assert.ok(summary.includes('工具：read_file'));
ok('规则摘要：起点/收尾/工具');

const tags = deriveTags(EVENTS);
assert.ok(tags.includes('read_file'));
assert.ok(tags.some((t) => t.includes('A:\\')), '应抽出文件路径');
ok('标签：工具名 + 文件路径');

// 空文本事件不炸
const bare = buildCard({
  sid: 's',
  date: '2026-11-05',
  events: [{ seq: 1, type: 'tool/result', data: { message: { content: [] } } }],
  archivePath: 'x.md',
});
assert.ok(bare.title.includes('tool/result'));
ok('无文本事件：回退成区间描述');

console.log(`\n通过 ${passed} 项。`);
