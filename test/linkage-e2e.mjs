/**
 * 黑洞 × 书同文 合体端到端（手动跑，不进 npm test —— 它要读到隔壁 dsh-tongwen 的源码）。
 *
 * 为什么要有这层：两个插件之间没有任何函数调用，只认「名片 + events.jsonl」。
 * 所以唯一能证明「真的合上了」的办法，是让黑洞真写一次事件、再让书同文真读一次，
 * 看它有没有进账本。全程用临时目录，绝不碰真实的 A:\tongwen\logs\账本 和 A:\dsh-home\blackhole。
 *
 * 跑法：node test/linkage-e2e.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, EVENT_TYPE, eventsPath } from '../src/events.js';

import { pathToFileURL } from 'node:url';

const TONGWEN = pathToFileURL('<plugins>/dsh-tongwen/lib/organs.js').href;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-linkage-'));
const stateRoot = path.join(root, 'blackhole-state');
const organsRoot = path.join(root, 'organs');
const organDir = path.join(organsRoot, 'dsh-blackhole');
const ledgerRoot = path.join(root, 'tongwen-root');
fs.mkdirSync(organDir, { recursive: true });
fs.mkdirSync(ledgerRoot, { recursive: true });

console.log('黑洞 × 书同文 · 合体端到端');

// 1) 名片：跟真实 A:\dsh-plugins\dsh-blackhole\organ.json 同形状，events.path 指向临时 stateRoot
{
  const card = {
    id: 'blackhole-e2e',
    name: '黑洞插件（e2e 临时）',
    version: 'e2e',
    kind: 'inner',
    status: 'active',
    events: { path: eventsPath(stateRoot) },
    abilities: [
      {
        name: 'blackhole.index.read',
        entry: { type: 'file', path: path.join(root, '索引.md') },
        sideEffect: 'read',
      },
    ],
    health: { probe: 'file-mtime', path: path.join(root, 'trace.log') },
  };
  fs.writeFileSync(path.join(organDir, 'organ.json'), `${JSON.stringify(card, null, 2)}\n`, 'utf8');
  ok('临时名片写好（events.path 指向临时 stateRoot）');
}

// 2) 黑洞真写三类事件（走 appendEvent，不是手写字符串）
{
  const now = new Date();
  appendEvent(stateRoot, {
    type: EVENT_TYPE.ARCHIVED,
    subject: 'e2e 归档',
    payload: { session: 's-e2e', start: 9, end: 12, events: 4, archive: 'X:/a/9-12.md' },
    now,
  });
  appendEvent(stateRoot, {
    type: EVENT_TYPE.SKIPPED,
    subject: 'e2e 跳过',
    payload: { session: 's-e2e', start: 13, end: 13, events: 1, reason: 'events=1 < 2' },
    now,
  });
  appendEvent(stateRoot, {
    type: EVENT_TYPE.FAILED,
    severity: 'warn',
    subject: 'e2e 失败',
    payload: { session: 's-e2e', start: 20, end: 22, error: 'summary too long', abandoned: true },
    now,
  });
  const lines = fs.readFileSync(eventsPath(stateRoot), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  ok('黑洞写出三类事件（归档 / 跳过 / 失败）');
}

// 3) 书同文真读一次（只用它自己的 ingestOrganEvents，不复制逻辑）
{
  const { ingestOrganEvents } = await import(TONGWEN);
  const ingested = await ingestOrganEvents({ root: ledgerRoot }, { 'organs.roots': organsRoot });
  assert.equal(ingested, 3, `书同文应读进 3 条，实际 ${ingested}`);

  const ledger = fs.readFileSync(path.join(ledgerRoot, 'logs', '账本', 'data', 'records.jsonl'), 'utf8');
  const records = ledger.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(record.type, 'organ');
    assert.equal(record.source, 'organ:blackhole-e2e');
    assert.equal(record.data.organ, 'blackhole-e2e');
    assert.equal(record.data.known, true, `事件类型应被书同文认识：${record.data.eventType}`);
    assert.match(record.at, /^\d{4}-\d{2}-\d{2}T/);
  }
  const types = records.map((r) => r.data.eventType);
  assert.deepEqual(types, [EVENT_TYPE.ARCHIVED, EVENT_TYPE.SKIPPED, EVENT_TYPE.FAILED]);
  ok('书同文把三条事件读进账本，known=true（类型已在词表里）');
}

// 4) 再来一次：不该重复读（offset 生效）
{
  const { ingestOrganEvents } = await import(TONGWEN);
  const again = await ingestOrganEvents({ root: ledgerRoot }, { 'organs.roots': organsRoot });
  assert.equal(again, 0, '重复读取应为 0（按 offset 增量）');
  ok('重复读取为 0（书同文按 offset 增量）');
}

// 5) 追加一条新事件：只读那一条
{
  appendEvent(stateRoot, { type: EVENT_TYPE.ARCHIVED, subject: 'e2e 第二条归档', payload: { start: 30, end: 40 } });
  const { ingestOrganEvents } = await import(TONGWEN);
  const one = await ingestOrganEvents({ root: ledgerRoot }, { 'organs.roots': organsRoot });
  assert.equal(one, 1, '只应读到新追加的那一条');
  ok('增量读取：只读新追加的一条');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`✅ 合体端到端 ${passed} 项通过`);
