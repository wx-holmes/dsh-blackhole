import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeBlackholeEngine } from '../src/engine.js';

// 单测别往生产 trace.log 里写：trace 路径走环境变量。
process.env.BLACKHOLE_TRACE = path.join(os.tmpdir(), `bh-trace-${path.basename(process.argv[1] ?? 'test')}-${process.pid}.log`);

const ROOT = '~/archive\\scratch\\blackhole-pipeline';
const ARCHIVE = path.join(ROOT, 'archive');
const STATE = path.join(ROOT, 'state');
fs.rmSync(ROOT, { recursive: true, force: true });

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

const EVENTS = [
  { seq: 12, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '黑洞测试：把这段归档。' }] } } },
  { seq: 13, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好，先读事件。' }, { type: 'tool-call', name: 'read_file', arguments: {} }] } } },
  { seq: 14, type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: '原始输出' }] } } },
];

const fakeSession = {
  id: 'session-pipeline-1',
  surface: { nodes: [12, 13, 14] },
  eventAt: (seq) => EVENTS.find((e) => e.seq === Number(seq)),
};

/** 假 Base：模拟 BasicCompactionEngine 的 compactRegion。 */
class FakeBase {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.calls = [];
    this.throwOnRegion = false;
  }
  async compactRegion(start, end, agent, signal) {
    this.calls.push({ start, end });
    if (this.throwOnRegion) throw new Error('summary too long');
    return { shadowedRange: { start, end }, shadowedTokenCount: 100 };
  }
}

const ctx = { logger: { warn: (m) => console.log('    [warn]', m) } };
const Engine = makeBlackholeEngine(FakeBase, { archiveRoot: ARCHIVE, stateRoot: STATE });

console.log('U2b 胶水 · 单测');

// 1. 成功路径
const engine = new Engine(ctx, {});
const result = await engine.compactRegion(12, 14, { session: fakeSession }, undefined);
assert.equal(result.shadowedRange.start, 12);
assert.equal(engine.calls.length, 1, '应调用父类 compactRegion');
ok('成功路径：调父类压缩');

// 2. 归档文件
const sidDir = path.join(ARCHIVE, 'session-pipeline-1');
assert.ok(fs.existsSync(sidDir), '原文目录应存在');
const dayDir = fs.readdirSync(sidDir)[0];
const files = fs.readdirSync(path.join(sidDir, dayDir)).filter((f) => f.endsWith('.md'));
assert.equal(files.length, 1, '应有一个归档文件');
assert.match(files[0], /^12-14\.md$/);
const body = fs.readFileSync(path.join(sidDir, dayDir, files[0]), 'utf8');
assert.ok(body.includes('state: committed'), '应已提交');
assert.ok(body.includes('黑洞测试：把这段归档。'), '原文逐字');
assert.ok(body.includes('原始输出'), '工具结果逐字');
ok('归档落盘：self 路径 + state committed + 逐字');

// 3. 索引卡
const jsonl = fs.readFileSync(path.join(ARCHIVE, 'index.jsonl'), 'utf8').trim().split('\n');
assert.equal(jsonl.length, 1, 'index.jsonl 应有一行');
const card = JSON.parse(jsonl[0]);
assert.ok(card.cardId.startsWith('bh_'));
assert.deepEqual(card.range, [12, 14]);
assert.ok(card.src.includes('12-14.md'));
assert.ok(fs.existsSync(path.join(ARCHIVE, '索引.md')), '人读索引应存在');
assert.ok(fs.readFileSync(path.join(ARCHIVE, '索引.md'), 'utf8').includes('黑洞测试'));
ok('索引卡：index.jsonl + 索引.md');

// 4. pending 已清理，stats 正确
assert.equal(engine.archive.list().length, 0, 'pending 应清空');
assert.equal(engine.stats().archived, 1);
assert.equal(engine.stats().failed, 0);
ok('提交后无孤儿 pending');

// 5. 失败路径：父类抛错 → abandon，原文保留（用另一段区间，避免复用已提交记录）
const engine2 = new Engine(ctx, {});
engine2.throwOnRegion = true;
let threw = false;
try {
  await engine2.compactRegion(13, 14, { session: fakeSession }, undefined);
} catch (error) {
  threw = true;
  assert.match(error.message, /summary too long/);
}
assert.equal(threw, true, '父类失败应向上抛');
assert.equal(engine2.stats().failed, 1);
const sidDir2 = path.join(ARCHIVE, 'session-pipeline-1');
const dayDir2 = fs.readdirSync(sidDir2)[0];
const abandoned = fs.readdirSync(path.join(sidDir2, dayDir2)).filter((f) => f.endsWith('.abandoned'));
assert.ok(abandoned.length >= 1, 'abandon 应保留原文（.abandoned）');
ok('失败路径：abandon 保留原文、错误上抛');

// 6. 空区间不炸
const engine3 = new Engine(ctx, {});
const r3 = await engine3.compactRegion(99, 100, { session: fakeSession }, undefined);
assert.equal(r3.shadowedRange.start, 99);
ok('空区间：照常调父类，不归档');

console.log(`\n通过 ${passed} 项。`);
