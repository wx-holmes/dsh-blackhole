/**
 * 区间取事件的单测（2026-11-06）。
 *
 * 为什么单独测：DSH 的 surface 是按「位置」排的，seq 不一定单调——压缩产生的摘要节点
 * 带着最新 seq 却插在保留区的前面。如果归档取区间还按数字筛，就会把整段原文漏掉，
 * 甚至一个事件都取不到。这个测试盯两件事：
 *   1. 正常单调 surface：照旧按数字区间取；
 *   2. 非单调 surface（5443 在 5401 前面）：按位置取，不漏不重。
 */
import assert from 'node:assert/strict';
import { collectRegionEvents } from '../src/region.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

function sessionOf(nodes) {
  const events = new Map(nodes.map((seq) => [seq, { seq, type: 'user/message', data: {} }]));
  return {
    id: 's-region',
    surface: { nodes },
    eventAt: (seq) => events.get(seq),
  };
}

console.log('区间取事件 · 单测');

// 1) 单调 surface：数字区间和位置区间一致
{
  const session = sessionOf([1, 2, 3, 4, 5]);
  const events = collectRegionEvents(session, 2, 4);
  assert.deepEqual(
    events.map((event) => event.seq),
    [2, 3, 4]
  );
  ok('单调 surface：按数字区间取到 2..4');
}

// 2) 非单调 surface：5443（摘要，最新）在 5401 前面，位置有序
{
  const session = sessionOf([5443, 5401, 5405, 5408, 5410]);
  const events = collectRegionEvents(session, 5443, 5408);
  assert.deepEqual(
    events.map((event) => event.seq),
    [5443, 5401, 5405, 5408],
    '应按位置取到四个节点，而不是按数字只取到 5443'
  );
  ok('非单调 surface：按位置取到 5443/5401/5405/5408，不漏');
}

// 3) 两端不在 surface 上：退回数字区间（兜底路径不炸）
{
  const session = sessionOf([10, 11, 12]);
  const events = collectRegionEvents(session, 100, 200);
  assert.deepEqual(events, []);
  ok('两端不在 surface：兜底返回空，不抛错');
}

console.log(`✅ 区间取事件 ${passed} 项通过`);
