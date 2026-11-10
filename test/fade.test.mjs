/**
 * 先剪后折单测（2026-11-07）。
 *
 * 盯住四件事：
 *   1. 超预算的工具输出被剪成 头 + 标记 + 尾，且结果比原文小、在预算内；
 *   2. 没超预算的一律不动（返回 null）；
 *   3. 非文本块（图片等）原样保留、顺序不变；
 *   4. fadeRange 只改 tool/result，替换走 surfaceOp.replace，失败不影响外层。
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fadeContent, fadeRange, resolveFadeConfig, FADE_MARKER, codePointLength } from '../src/fade.js';

process.env.BLACKHOLE_TRACE = path.join(os.tmpdir(), `bh-fade-${process.pid}.log`);
process.env.BLACKHOLE_SAMPLE = path.join(os.tmpdir(), `bh-sample-${path.basename(process.argv[1] ?? 'test')}-${process.pid}.jsonl`);

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ok  ${name}`);
};

const config = resolveFadeConfig({ fadeMinChars: 1000, fadeHeadChars: 300, fadeTailChars: 100 });

console.log('先剪后折 · 单测');

// 1) 超预算 → 剪，且只剩「头 + 标记 + 尾」
{
  const big = 'H'.repeat(600) + 'M'.repeat(5000) + 'T'.repeat(400);
  const out = fadeContent([{ type: 'text', text: big }], config);
  assert.ok(Array.isArray(out), '应当返回新内容');
  const text = out.map((b) => b.text ?? '').join('');
  assert.ok(text.includes(FADE_MARKER.trim()), '应插入标记');
  assert.ok(text.startsWith('H'.repeat(300)), '头应保留 300 码点');
  assert.ok(text.endsWith('T'.repeat(100)), '尾应保留 100 码点');
  assert.ok(codePointLength(text) <= config.thresholdChars, '剪后不应超预算');
  assert.ok(codePointLength(text) < codePointLength(big), '剪后必须更小');
  ok('超预算剪成 头+标记+尾');
}

// 2) 未超预算 → 不动
{
  const small = 'x'.repeat(500);
  assert.equal(fadeContent([{ type: 'text', text: small }], config), null);
  ok('未超预算返回 null');
}

// 3) 非文本块保留且顺序不变
{
  const big = 'A'.repeat(4000);
  const out = fadeContent(
    [
      { type: 'text', text: big },
      { type: 'image', url: 'x' },
    ],
    config
  );
  assert.equal(out.length, 2);
  assert.equal(out[1].type, 'image');
  assert.equal(out[1].url, 'x');
  ok('非文本块原样保留');
}

// 4) fadeRange：只碰 tool/result，替换带 surfaceOp，计数正确
{
  const appended = [];
  const sessions = {
    surface: { nodes: [1, 2, 3] },
    eventAt(seq) {
      if (seq === 2) return { type: 'tool/result', data: { message: { source: { callId: 'c1' } } } };
      return { type: 'assistant/message', data: {} };
    },
    deriveEventMessage(event) {
      if (event.type !== 'tool/result') return { content: [] };
      return { role: 'tool', content: [{ type: 'text', text: 'B'.repeat(5000) }] };
    },
    append(type, data, meta) {
      appended.push({ type, data, meta });
      return { seq: 900 + appended.length };
    },
  };
  const out = fadeRange({ session: sessions, start: 1, end: 3, meter: { estimateMessage: () => 123 }, config, trace: () => {} });
  assert.equal(out.faded, 1, '只该剪一条');
  assert.equal(out.seqs[0], 2);
  assert.ok(out.charsAfter < out.charsBefore);
  const replacement = appended.find((a) => a.type === 'tool/result');
  assert.ok(replacement, '应有替换事件');
  assert.deepEqual(replacement.meta.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 });
  assert.deepEqual(replacement.meta.sourceEventSeqs, [2]);
  const shadow = appended.find((a) => a.type === 'compaction/prune');
  assert.ok(shadow, '应有 compaction/prune 影子事件');
  assert.equal(shadow.data.shadowedTokenCount, 123);
  ok('fadeRange 替换与影子事件正确');
}

// 5) 坏 session 不抛
{
  const out = fadeRange({ session: null, start: 1, end: 2, config });
  assert.equal(out.faded, 0);
  ok('坏 session 降级为不剪');
}

console.log(`\n先剪后折 · ${passed} 项通过`);
