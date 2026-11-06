/**
 * 窄段门槛单测（2026-11-05）。
 *
 * 为什么要这层门槛：trace.log 里 27 次失败有 17 次是「只有 1 个事件的前缀」——
 * 摘要几乎不可能比原文短，父类直接抛 summary is not smaller than the shadowed content。
 * 这个测试盯住四件事：
 *   1. 太窄 → 跳过，不发归档、不调父类；
 *   2. 够宽 → 放行，照常调父类；
 *   3. token 太少也算窄（事件数够但内容稀）；
 *   4. 跳过导致的「still above threshold」被吞掉，别的错误照常往外抛。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBlackholeEngine } from '../src/engine.js';

// 单测别往生产 trace.log 里写：trace 路径走环境变量。
process.env.BLACKHOLE_TRACE = path.join(os.tmpdir(), `bh-trace-${path.basename(process.argv[1] ?? 'test')}-${process.pid}.log`);

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-gate-'));
const paths = {
  archiveRoot: path.join(root, 'archive'),
  stateRoot: path.join(root, 'state'),
  pendingTtlMs: 600000,
};

function makeCtx(nodes) {
  return {
    tokenMeter: { measure: () => ({ nodes }) },
    logger: { warn() {}, info() {} },
  };
}

const session = { id: 's-gate', surface: { nodes: [] }, events: [] };
const agent = { session };

class FakeBase {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.regionCalls = 0;
  }
  async compactRegion(start, end) {
    this.regionCalls += 1;
    return { start, end, ok: true };
  }
}

const Engine = makeBlackholeEngine(FakeBase, paths);

console.log('窄段门槛 · 单测');

// 1) 单事件段：跳过，不归档也不调摘要器
{
  const engine = new Engine(makeCtx([{ seq: 10, tokens: 5000 }]), {});
  const out = await engine.compactRegion(10, 10, agent);
  assert.equal(out, null);
  assert.equal(engine.regionCalls, 0, '不该调父类 compactRegion');
  assert.equal(engine.blackhole.skipped, 1);
  ok('单事件段直接跳过');
}

// 2) 8 事件段：放行
{
  const nodes = Array.from({ length: 8 }, (_, i) => ({ seq: 10 + i, tokens: 1200 }));
  const engine = new Engine(makeCtx(nodes), {});
  const out = await engine.compactRegion(10, 17, agent);
  assert.equal(out?.ok, true);
  assert.equal(engine.regionCalls, 1);
  assert.equal(engine.blackhole.skipped, 0);
  ok('8 事件段放行（走父类）');
}

// 3) 事件数够但 token 太少：也算窄
{
  const nodes = [
    { seq: 1, tokens: 100 },
    { seq: 2, tokens: 100 },
    { seq: 3, tokens: 100 },
  ];
  const engine = new Engine(makeCtx(nodes), {});
  const out = await engine.compactRegion(1, 3, agent);
  assert.equal(out, null);
  assert.equal(engine.regionCalls, 0);
  ok('3 事件但仅 300 tokens → 跳过');
}

// 4) 门槛可配：events 放到 1 就放行单事件段
{
  const LooseEngine = makeBlackholeEngine(FakeBase, { ...paths, minCompactEvents: 1 });
  const engine = new LooseEngine(makeCtx([{ seq: 5, tokens: 9000 }]), {});
  const out = await engine.compactRegion(5, 5, agent);
  assert.equal(out?.ok, true);
  ok('minCompactEvents=1 时单事件段放行（门槛可配）');
}

// 5) 拿不到 measurement 时不拦
{
  const ctx = { tokenMeter: { measure: () => undefined }, logger: { warn() {}, info() {} } };
  const engine = new Engine(ctx, {});
  const out = await engine.compactRegion(1, 99, agent);
  assert.equal(out?.ok, true);
  ok('量不出来就放行（不拦）');
}

// 6) 跳过导致的「still above threshold」被吞掉
{
  class SkipBase {
    constructor(ctx, config) {
      this.ctx = ctx;
      this.config = config;
    }
    async compactRegion() {
      throw new Error('父类应通过 this.compactRegion 走到门槛，不该直接到这里');
    }
    async compactIfNeeded(ag) {
      await this.compactRegion(10, 10, ag); // this 指向黑洞口，会被门槛拦下
      throw new Error('compaction still above threshold after 3 compaction attempts (900000 >= 629145)');
    }
  }
  const SkipEngine = makeBlackholeEngine(SkipBase, paths);
  const engine = new SkipEngine(makeCtx([{ seq: 10, tokens: 100 }]), {});
  const out = await engine.compactIfNeeded(agent, 'pressure');
  assert.equal(out, null, '应该吞掉并按「等段变宽」处理');
  ok('窄段跳过后的「still above threshold」不再往外冒');
}

// 7) 真错误不许被吞
{
  class BoomBase {
    constructor(ctx, config) {
      this.ctx = ctx;
      this.config = config;
    }
    async compactRegion() {
      return { ok: true };
    }
    async compactIfNeeded() {
      throw new Error('summary is not smaller than the shadowed content (3497 estimated framed tokens >= 3453)');
    }
  }
  const BoomEngine = makeBlackholeEngine(BoomBase, paths);
  const engine = new BoomEngine(makeCtx([{ seq: 10, tokens: 5000 }]), {});
  await assert.rejects(
    () => engine.compactIfNeeded(agent, 'pressure'),
    /summary is not smaller than the shadowed content/
  );
  ok('真实摘要失败照常抛出');
}

// 8) 非单调 surface：seq 倒挂但位置有序 → 按位置算，不许误判成窄段
//    真实场景：压缩后摘要节点带最新 seq 却插在保留区最前面（5443 在 5401 前面），
//    父类按位置取区间，数字是倒挂的。之前按数字筛会得到 events=0 → 永远跳过 → 压不动。
{
  const nodes = [
    { seq: 5443, tokens: 4000 }, // 摘要节点（最新 seq，插在最前）
    { seq: 5401, tokens: 3000 },
    { seq: 5405, tokens: 3000 },
    { seq: 5408, tokens: 1000 }, // 保留区边界前最后一个
    { seq: 5410, tokens: 9000 }, // 保留区（不该被算进区间）
  ];
  const engine = new Engine(makeCtx(nodes), {});
  const span = engine.spanStats(session, 5443, 5408);
  assert.equal(span.events, 4, '按位置应含 5443/5401/5405/5408 四个节点');
  assert.equal(span.tokens, 11000);
  const out = await engine.compactRegion(5443, 5408, agent);
  assert.equal(out?.ok, true, '够宽就该放行给父类');
  ok('非单调 surface：seq 倒挂但位置有序，按位置算不误判窄段');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`✅ 窄段门槛 ${passed} 项通过`);
