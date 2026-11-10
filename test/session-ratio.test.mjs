/**
 * 按会话覆盖事件视界（2026-11-08）：QQ 中枢多步协议单列档位。
 *
 * 三条要证明的：
 * 1. 命中的会话看到的 thresholdRatio 是覆盖值，不是全局值；
 * 2. super 返回后 config 必须还原，否则下一个时空会继承别人的档位；
 * 3. 前缀匹配取最长的一条，且没命中的会话完全不受影响。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bh-ratio-'));
process.env.BLACKHOLE_TRACE = path.join(tmp, 'trace.log');
process.env.BLACKHOLE_SAMPLE = path.join(tmp, 'surface.jsonl');

const { makeBlackholeEngine } = await import('../src/engine.js');

class FakeBase {
  constructor(ctx, config = {}) {
    this.config = config;
  }

  async compactIfNeeded() {
    // 父类真正读阈值的地方就这一下：记下它看到的
    FakeBase.lastSeen = this.config?.thresholdRatio;
    FakeBase.lastHorizon = this.config?.eventHorizon;
    return null;
  }
}

const Engine = makeBlackholeEngine(FakeBase, {
  archiveRoot: path.join(tmp, 'archive'),
  stateRoot: path.join(tmp, 'state'),
  sampleFile: path.join(tmp, 'surface.jsonl'),
  thresholdRatio: 0.7,
  sessionRatios: {
    'session-example': 0.5,
    // 更长的前缀应该赢
    'session-example-1fb6': 0.42,
    // 超过 solidifyLine 的要被压到 0.74
    'session-overlimit': 0.95,
    // 非法值直接忽略
    'session-bad': 'abc',
  },
});

const sessionsSeen = [];
async function run(id) {
  const engine = new Engine({}, { thresholdRatio: 0.7 });
  engine._sampleSurface = () => {}; // 采样不是这条测试的对象
  await engine.compactIfNeeded({ session: { id } }, 'pressure', null);
  sessionsSeen.push({ id, seen: FakeBase.lastSeen, after: engine.config?.thresholdRatio });
  return sessionsSeen.at(-1);
}

export const results = [];

// 1) 命中覆盖
let r = await run('session-example-1fb6-0001');
assert.equal(r.seen, 0.42, '最长前缀应生效');
assert.equal(r.after, 0.7, 'super 返回后必须还原全局档位');
results.push('PASS  命中覆盖：最长前缀 0.42，返回后还原 0.7');

// 2) 次长前缀
r = await run('session-example-ffff');
assert.equal(r.seen, 0.5);
results.push('PASS  次长前缀：0.5');

// 3) 未命中会话不受影响
r = await run('session-other-0002');
assert.equal(r.seen, 0.7);
results.push('PASS  未命中：仍走全局 0.7');

// 4) 超 solidifyLine 被夹到 0.74
r = await run('session-overlimit-xxx');
assert.equal(r.seen, 0.74);
results.push('PASS  越界夹紧：0.95 → 0.74');

// 5) 非法值忽略
r = await run('session-bad-xxx');
assert.equal(r.seen, 0.7);
results.push('PASS  非法值忽略：仍 0.7');

rmSync(tmp, { recursive: true, force: true });

console.log(results.join('\n'));
console.log(`\nsession-ratio: ${results.length}/${results.length} pass`);
