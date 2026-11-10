import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore } from '../src/archive.js';

const ROOT = path.join(os.tmpdir(), 'blackhole-test');
const ARCHIVE = path.join(ROOT, 'archive');
const STATE = path.join(ROOT, 'state');

fs.rmSync(ROOT, { recursive: true, force: true });

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

function makeEvents() {
  return [
    {
      seq: 12,
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text: '第一段原文：把归档写进 self。' }] } },
    },
    {
      seq: 13,
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '收到，这条要逐字保留。' },
            { type: 'tool-call', name: 'read', arguments: { path: '/tmp/x.md' } },
          ],
        },
      },
    },
    {
      seq: 14,
      type: 'tool/result',
      data: { message: { role: 'tool', content: [{ type: 'text', text: '工具输出：12345 行原始内容' }] } },
    },
  ];
}

const store = new ArchiveStore({
  archiveRoot: ARCHIVE,
  stateRoot: STATE,
  now: () => new Date('2026-11-05T07:20:00Z'),
});

console.log('U2 归档两阶段 · 单测');

// 1. staging
const staged = store.stage({
  sid: 'session-test-1',
  date: '2026-11-05',
  start: 12,
  end: 14,
  events: makeEvents(),
  callId: 'cmp-001',
});
assert.ok(fs.existsSync(staged.stagingPath), 'staging 文件应存在');
assert.equal(staged.state, 'staging');
assert.ok(staged.stagingPath.endsWith('.staging'));
ok('stage 写出临时原文');

// pending 记录
const pendingFile = path.join(STATE, 'pending', `${staged.key}.json`);
assert.ok(fs.existsSync(pendingFile), 'pending 记录应存在');
ok('stage 写 pending 记录');

// 临时文件里正文逐字
const stagingBody = fs.readFileSync(staged.stagingPath, 'utf8');
assert.ok(stagingBody.includes('第一段原文：把归档写进 self。'), '应逐字包含原文');
assert.ok(stagingBody.includes('工具输出：12345 行原始内容'), '应逐字包含工具结果');
assert.ok(stagingBody.includes('state: staging'));
ok('原文逐字落盘（含工具结果）');

// 2. pending
const pending = store.markPending(staged.key);
assert.equal(pending.state, 'pending');
ok('markPending 进入 pending');

// 3. commit
const committed = store.commit(staged.key);
assert.equal(committed.state, 'committed');
assert.ok(fs.existsSync(staged.finalPath), '正式文件应存在');
assert.ok(!fs.existsSync(staged.stagingPath), 'staging 应清理');
assert.ok(!fs.existsSync(pendingFile), 'pending 记录应清理');
const finalBody = fs.readFileSync(staged.finalPath, 'utf8');
assert.ok(finalBody.includes('state: committed'));
assert.ok(finalBody.includes('第一段原文：把归档写进 self。'));
ok('commit 写正式文件、清理临时与记录');

// 正式路径符合 self 规则
assert.ok(staged.finalPath.includes(path.join('session-test-1', '2026-11-05', '12-14.md')));
ok('路径符合 self/context/<sid>/<date>/<range>.md');

// 4. 幂等：同参数再 stage
const again = store.stage({
  sid: 'session-test-1',
  date: '2026-11-05',
  start: 12,
  end: 14,
  events: makeEvents(),
  callId: 'cmp-001',
});
assert.equal(again.key, staged.key, '幂等键应相同');
assert.equal(again.reused, true, '应复用已有记录');
ok('幂等：重复 stage 复用不重写');

// 5. abandon：另一段
const staged2 = store.stage({
  sid: 'session-test-1',
  date: '2026-11-05',
  start: 20,
  end: 22,
  events: makeEvents().map((e) => ({ ...e, seq: e.seq + 8 })),
  callId: 'cmp-002',
});
const abandoned = store.abandon(staged2.key, 'replacement-failed');
assert.equal(abandoned.state, 'abandoned');
assert.ok(fs.existsSync(`${staged2.finalPath}.abandoned`), 'abandon 应保留原文（改名 .abandoned）');
assert.ok(!fs.existsSync(path.join(STATE, 'pending', `${staged2.key}.json`)), 'abandon 应清理 pending');
ok('abandon 保留原文、清理 pending');

// 6. recover：造一个超时 pending
const oldStore = new ArchiveStore({
  archiveRoot: ARCHIVE,
  stateRoot: STATE,
  now: () => new Date('2026-11-05T00:00:00Z'),
  pendingTtlMs: 60 * 1000,
});
const staged3 = oldStore.stage({
  sid: 'session-test-1',
  date: '2026-11-05',
  start: 30,
  end: 32,
  events: makeEvents().map((e) => ({ ...e, seq: e.seq + 18 })),
  callId: 'cmp-003',
});
const freshStore = new ArchiveStore({
  archiveRoot: ARCHIVE,
  stateRoot: STATE,
  now: () => new Date('2026-11-05T07:20:00Z'),
  pendingTtlMs: 60 * 1000,
});
const recovered = freshStore.recover();
assert.equal(recovered.abandoned, 1, '超时 pending 应转 abandoned');
assert.ok(fs.existsSync(`${staged3.finalPath}.abandoned`));
ok('recover 把超时 pending 转 abandoned、原文保留');

// 7. 内容变了 → 幂等键不同
const changed = store.stage({
  sid: 'session-test-1',
  date: '2026-11-05',
  start: 12,
  end: 14,
  events: makeEvents().map((e) => (e.seq === 12 ? { ...e, data: { message: { role: 'user', content: [{ type: 'text', text: '改过的原文' }] } } } : e)),
  callId: 'cmp-001',
});
assert.notEqual(changed.key, staged.key, '内容变了键应不同');
ok('内容变化 → 幂等键变化');

console.log(`\n通过 ${passed} 项。`);
