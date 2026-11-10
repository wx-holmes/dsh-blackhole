/**
 * 折叠冷却（2026-11-09）：同一会话窗口内最多真折 N 次，超了就这一轮不折。
 *
 * 要证明的三条：
 * 1. 前 N 次照常进父类，第 N+1 次被挡在门外（父类根本没被调）；
 * 2. 窗口滑过之后自动恢复，不需要重启；
 * 3. 关掉开关（max=0）时完全不管，行为回到改之前。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bh-cooldown-'));
process.env.BLACKHOLE_TRACE = path.join(tmp, 'trace.log');
process.env.BLACKHOLE_SAMPLE = path.join(tmp, 'surface.jsonl');

const { makeBlackholeEngine } = await import('../src/engine.js');

class FakeBase {
  constructor(ctx, config = {}) {
    this.config = config;
  }

  async compactIfNeeded() {
    FakeBase.calls += 1;
    return { ok: true }; // 返回非 null = 真折过
  }
}
FakeBase.calls = 0;

const Engine = makeBlackholeEngine(FakeBase, {
  archiveRoot: path.join(tmp, 'archive'),
  stateRoot: path.join(tmp, 'state'),
  sampleFile: path.join(tmp, 'surface.jsonl'),
  thresholdRatio: 0.3,
  foldCooldownMs: 80,
  foldCooldownMax: 2,
});

const engine = new Engine({}, { thresholdRatio: 0.3 });
engine._sampleSurface = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = () => engine.compactIfNeeded({ session: { id: 'session-busy' } }, 'pressure', null);

const results = [];

// 1) 前两次进父类
await run();
await run();
assert.equal(FakeBase.calls, 2, '前两次应该真折');
results.push('PASS  前两次正常折叠，父类被调 2 次');

// 2) 第三次被冷却挡住，父类不再被调
const third = await run();
assert.equal(third, null);
assert.equal(FakeBase.calls, 2, '冷却期内不该再调父类');
results.push('PASS  第三次被冷却挡住：返回 null，父类没被调');

// 3) 别的会话不受影响（冷却按会话隔离）
await engine.compactIfNeeded({ session: { id: 'session-other' } }, 'pressure', null);
assert.equal(FakeBase.calls, 3);
results.push('PASS  别的会话不受影响：仍然照常折');

// 4) 窗口过期后恢复
await sleep(120);
await run();
assert.equal(FakeBase.calls, 4, '窗口过了应该恢复');
results.push('PASS  窗口滑过后自动恢复，不需要重启');

// 5) 关掉开关时完全不管
class AlwaysBase {
  constructor(ctx, config = {}) {
    this.config = config;
  }
  async compactIfNeeded() {
    AlwaysBase.calls += 1;
    return { ok: true };
  }
}
AlwaysBase.calls = 0;
const OffEngine = makeBlackholeEngine(AlwaysBase, {
  archiveRoot: path.join(tmp, 'archive2'),
  stateRoot: path.join(tmp, 'state2'),
  sampleFile: path.join(tmp, 'surface2.jsonl'),
  thresholdRatio: 0.3,
  foldCooldownMs: 0,
  foldCooldownMax: 0,
});
const off = new OffEngine({}, { thresholdRatio: 0.3 });
off._sampleSurface = () => {};
for (let i = 0; i < 5; i += 1) await off.compactIfNeeded({ session: { id: 'session-x' } }, 'pressure', null);
assert.equal(AlwaysBase.calls, 5, '关掉冷却时每次都该折');
results.push('PASS  关掉开关（0/0）：5 次全部照折');

// 临时目录留到最后一起删：下面还要复用同一份 stateRoot 验证落盘

// ---------------------------------------------------------------------------
// 2026-11-09 23:40 加固：计数落盘 + 两条放行
// ---------------------------------------------------------------------------
const shared = path.join(tmp, 'state-shared');
class PersistBase {
  constructor(ctx, config = {}) {
    this.config = config;
  }
  async compactIfNeeded() {
    PersistBase.calls += 1;
    return { ok: true };
  }
}
PersistBase.calls = 0;
const mkPersist = () =>
  new (makeBlackholeEngine(PersistBase, {
    archiveRoot: path.join(tmp, 'archive-p'),
    stateRoot: shared,
    sampleFile: path.join(tmp, 'surface-p.jsonl'),
    thresholdRatio: 0.3,
    foldCooldownMs: 600000,
    foldCooldownMax: 2,
  }))({}, { thresholdRatio: 0.3 });

const p1 = mkPersist();
p1._sampleSurface = () => {};
await p1.compactIfNeeded({ session: { id: 'session-p' } }, 'pressure', null);
await p1.compactIfNeeded({ session: { id: 'session-p' } }, 'pressure', null);
assert.equal(PersistBase.calls, 2);
assert.ok(existsSync(path.join(shared, 'foldguard.json')), '应该在 stateRoot 落一份 foldguard.json');
results.push('PASS  折叠计数写进 stateRoot/foldguard.json');

// 新实例（= 插件重载/重启）读回同一份账，立刻被拦住
const p2 = mkPersist();
p2._sampleSurface = () => {};
const afterReload = await p2.compactIfNeeded({ session: { id: 'session-p' } }, 'pressure', null);
assert.equal(afterReload, null);
assert.equal(PersistBase.calls, 2, '重启后不该再折（旧行为会清空计数）');
results.push('PASS  重启后计数还在：第三次仍被拦，父类没被调');

// 放行一：连续被拦够 foldBypassStreak 次 → 放行
p2._recordFold('session-q');
p2._recordFold('session-q');
let guardOpenAt = -1;
for (let i = 1; i <= 10; i += 1) {
  const blocked = p2._foldBlocked('session-q', { tokens: 1000, windowTokens: 0 });
  if (!blocked) {
    guardOpenAt = i;
    break;
  }
}
assert.equal(guardOpenAt, 8, '第 8 次（连续被拦满 8 次）应放行');
results.push('PASS  连续被拦 8 次后放行：不会无限期憋着');

// 放行二：tokens 贴到硬顶的 95% → 立刻放行
p2._recordFold('session-r');
p2._recordFold('session-r');
assert.equal(p2._foldBlocked('session-r', { tokens: 100, windowTokens: 1048576 }), true);
const hardOpen = p2._foldBlocked('session-r', { tokens: 900000, windowTokens: 1048576 });
assert.equal(hardOpen, false, '900k 已过 0.9*0.95=896k，应放行');
results.push('PASS  到硬顶 95% 立刻放行：重启后也不会憋爆');

console.log(results.join('\n'));
rmSync(tmp, { recursive: true, force: true });
console.log(`\nfold-cooldown: ${results.length}/${results.length} pass`);
