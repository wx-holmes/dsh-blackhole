/**
 * 器官事件单测（2026-11-05，合体用）。
 *
 * 为什么要这层：书同文按 organ.json 的 events.path 读 events.jsonl，
 * 把「压缩归档 / 窄段跳过 / 压缩失败」记进账本。契约（handoff/规范/联动契约.md §2.2）
 * 要求八个字段齐全、只追加、路径与名片一致。这个测试盯住四件事：
 *   1. 三类事件各写一行，字段齐全（ts/id/source/type/severity/subject/payload/trace）；
 *   2. 路径 = <stateRoot>/events.jsonl（跟 organ.json 声明的一模一样）；
 *   3. ts 带时区偏移（契约示例是本地时间 +08:00）；
 *   4. 写事件失败/关闭时绝不影响压缩主流程。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBlackholeEngine } from '../src/engine.js';
import { appendEvent, eventsPath, localIso, readEvents, EVENT_SOURCE, EVENT_TYPE } from '../src/events.js';

// 单测别往生产 trace.log 里写：trace 路径走环境变量。
process.env.BLACKHOLE_TRACE = path.join(os.tmpdir(), `bh-trace-${path.basename(process.argv[1] ?? 'test')}-${process.pid}.log`);

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-events-'));
const paths = {
  archiveRoot: path.join(root, 'archive'),
  stateRoot: path.join(root, 'state'),
  pendingTtlMs: 600000,
};

function makeCtx(nodes) {
  return { tokenMeter: { measure: () => ({ nodes }) }, logger: { warn() {}, info() {} } };
}

function makeSession(id, seqs) {
  return {
    id,
    surface: { nodes: seqs },
    eventAt: (seq) => ({ seq, type: 'test/event', data: {} }),
  };
}

class OkBase {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }
  async compactRegion(start, end) {
    return { start, end, ok: true };
  }
}

class BoomBase extends OkBase {
  async compactRegion(start, end) {
    throw new Error('summary is not smaller than the shadowed content (3497 >= 3453)');
  }
}

const Engine = makeBlackholeEngine(OkBase, paths);

console.log('器官事件 · 单测');

// 1) 三类事件：跳过 / 归档 / 失败
{
  const seqs = [10, 11, 12];
  const agent = { session: makeSession('s-ev', seqs) };

  // 跳过：只有一个事件
  const skipEngine = new Engine(makeCtx([{ seq: 10, tokens: 5000 }]), {});
  await skipEngine.compactRegion(10, 10, agent);

  // 归档：三个足够宽的段
  const archiveEngine = new Engine(makeCtx(seqs.map((s) => ({ seq: s, tokens: 2000 }))), {});
  await archiveEngine.compactRegion(10, 12, agent);

  // 失败：父类抛错（换个区间，避免幂等复用上一段的 committed 记录）
  const boomAgent = { session: makeSession('s-ev', [20, 21, 22]) };
  const BoomEngine = makeBlackholeEngine(BoomBase, paths);
  const boomEngine = new BoomEngine(makeCtx([20, 21, 22].map((s) => ({ seq: s, tokens: 2000 }))), {});
  await assert.rejects(() => boomEngine.compactRegion(20, 22, boomAgent), /not smaller/);

  const events = readEvents(paths.stateRoot);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [EVENT_TYPE.SKIPPED, EVENT_TYPE.ARCHIVED, EVENT_TYPE.FAILED]);
  ok('三类事件各写一行，顺序与触发顺序一致');
}

// 2) 字段齐全 + 值对得上
{
  const events = readEvents(paths.stateRoot);
  const [skipped, archived, failed] = events;
  for (const event of events) {
    for (const field of ['ts', 'id', 'source', 'type', 'severity', 'subject', 'payload', 'trace']) {
      assert.ok(field in event, `缺字段 ${field}`);
    }
    assert.equal(event.source, EVENT_SOURCE);
    assert.ok('owner' in event.payload, 'payload 里必须有 owner（合体接入清单 §五②）');
    assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  }
  assert.equal(skipped.payload.owner, null, '没配 owner 时写 null，不留空串');
  assert.equal(skipped.severity, 'info');
  assert.equal(skipped.payload.events, 1);
  assert.equal(skipped.payload.session, 's-ev');
  assert.equal(archived.severity, 'info');
  assert.equal(archived.payload.events, 3);
  assert.ok(archived.payload.archive, '归档事件要带落盘路径');
  assert.ok(archived.payload.archive.endsWith('.md'));
  assert.equal(failed.severity, 'warn');
  assert.equal(failed.payload.abandoned, true, '失败时原文应保留为 .abandoned');
  assert.equal(failed.payload.start, 20);
  assert.ok(failed.payload.archive.endsWith('.abandoned'));
  assert.ok(failed.payload.error.includes('not smaller'));
  ok('字段齐全、值对得上（含归档路径与 abandoned 原文）');
}

// 3) 路径与 organ.json 声明的 events.path 一致
{
  assert.equal(eventsPath(paths.stateRoot), path.join(paths.stateRoot, 'events.jsonl'));
  assert.ok(fs.existsSync(path.join(paths.stateRoot, 'events.jsonl')));
  ok('事件落在 <stateRoot>/events.jsonl（与 organ.json 一致）');
}

// 4) id 唯一、行数 = 事件数
{
  const events = readEvents(paths.stateRoot);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
  const lines = fs.readFileSync(path.join(paths.stateRoot, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, events.length);
  ok('id 唯一、一事件一行');
}

// 5) 关掉事件就不写（events:false），压缩照常
{
  const QuietEngine = makeBlackholeEngine(OkBase, { ...paths, events: false });
  const before = readEvents(paths.stateRoot).length;
  const engine = new QuietEngine(makeCtx([{ seq: 10, tokens: 5000 }]), {});
  await engine.compactRegion(10, 10, { session: makeSession('s-quiet', [10]) });
  assert.equal(readEvents(paths.stateRoot).length, before);
  ok('events:false 时不写事件（压缩不受影响）');
}

// 6) 写盘炸了也不影响压缩
{
  const broken = path.join(root, 'broken-state');
  fs.writeFileSync(broken, 'not a directory');
  const BrokenEngine = makeBlackholeEngine(OkBase, { ...paths, stateRoot: broken });
  const engine = new BrokenEngine(makeCtx([{ seq: 10, tokens: 5000 }]), {});
  const out = await engine.compactRegion(10, 10, { session: makeSession('s-broken', [10]) });
  assert.equal(out, null, '窄段本来就返回 null');
  assert.equal(appendEvent(broken, { type: EVENT_TYPE.SKIPPED }), null, '写不进去应返回 null 而不是抛');
  ok('事件写盘失败时返回 null，压缩不受影响');
}

// 7) localIso 输出本地时间 + 偏移
{
  const ts = localIso(new Date('2026-11-05T00:10:00Z'));
  assert.match(ts, /[+-]\d{2}:\d{2}$/);
  assert.ok(!ts.endsWith('Z'));
  ok('localIso 输出带时区偏移');
}

// 8) 配了 owner 就写进 payload.owner（profile 归属），三个发射点都要带上
{
  const OwnerEngine = makeBlackholeEngine(OkBase, { ...paths, owner: 'blackhole-plugin' });
  const before = readEvents(paths.stateRoot).length;
  const engine = new OwnerEngine(makeCtx([{ seq: 30, tokens: 5000 }]), {});
  await engine.compactRegion(30, 30, { session: makeSession('s-owner', [30]) });
  const fresh = readEvents(paths.stateRoot).slice(before);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].payload.owner, 'blackhole-plugin');
  assert.equal(fresh[0].payload.session, 's-owner');
  ok('config.owner 写进 payload.owner（会话 id 仍在 payload.session）');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`✅ 器官事件 ${passed} 项通过`);
