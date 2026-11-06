/**
 * 块工具单测（A 段，2026-11-06）。
 *
 * 工具层是「独立性」的门面：即使 bili 不在，模型手里也该有 compress / restore /
 * search / status 四个能干活的工具。测试盯住五件事：
 *   1. 默认前缀 bh_，把 toolPrefix 置空就顶到原名（B/C 段摘 bili 时用同一份代码）；
 *   2. 四个工具都返回 { content:[{type:'text', text}] }，内容是 JSON；
 *   3. 失败一律 ok:false + code，不抛异常（空内容 / 不存在的 id / 空 query）；
 *   4. compress → restore 往返原文逐字一致；
 *   5. registerBlockTools：tools 服务不在、块仓没配、注册抛错，都只记日志不炸。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBlockTools, registerBlockTools } from '../src/tools.js';
import { EVENT_TYPE, appendEvent } from '../src/events.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}
function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bh-tools-${tag}-`));
}
// execute 返回纯 JSON 值（DSH ToolDefinition 约定），由 output.render 渲染成 content block。
function payload(result) {
  assert.equal(typeof result, 'object');
  assert.equal(result.ok, true);
  return result;
}
function rendered(result) {
  assert.equal(Array.isArray(result.content), true);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}
function byName(tools) {
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

// 1. 默认前缀与空前缀
{
  const root = tmpRoot('names');
  const tools = makeBlockTools({ blocksRoot: path.join(root, 'blocks') });
  assert.deepEqual(tools.map((t) => t.name), ['bh_compress', 'bh_restore', 'bh_search', 'bh_status']);
  const bare = makeBlockTools({ blocksRoot: path.join(root, 'blocks'), toolPrefix: '' });
  assert.deepEqual(bare.map((t) => t.name), ['compress', 'restore', 'search', 'status']);
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.execute, 'function');
    assert.ok(tool.timeoutMs > 0);
    // DSH 的 ToolDefinition 里 output 是必填（缺了 register 会抛）；
    // 这条断言就是为了防「注册数莫名其妙为 0」再犯。
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    const blocks = tool.output.render({}, { ok: true, n: 1 });
    assert.equal(blocks[0].type, 'text');
    assert.deepEqual(JSON.parse(blocks[0].text), { ok: true, n: 1 });
  }
  ok('默认前缀 bh_；toolPrefix:"" 顶到原名；四个工具都有描述/参数/output/execute');
}

// 2. 往返：compress → restore
{
  const root = tmpRoot('roundtrip');
  const tools = byName(makeBlockTools({ blocksRoot: path.join(root, 'blocks') }));
  const original = '# 会话摘录\n\n甲说了一些话。\n乙回了一些话。\n'.repeat(3);
  const written = payload(await tools.bh_compress.execute({ content: original, title: '往返', source: 'unit' }));
  assert.equal(written.ok, true);
  assert.match(written.id, /^bhb_[0-9]{8}_[0-9a-f]{8}$/);
  assert.ok(written.summary.length > 0);

  const back = payload(await tools.bh_restore.execute({ id: written.id }));
  assert.equal(back.ok, true);
  assert.equal(back.text, original, '原文逐字一致');
  assert.equal(back.truncated, false);

  const partial = payload(await tools.bh_restore.execute({ id: written.id, offset: 0, limit: 5 }));
  assert.equal(partial.text, original.slice(0, 5));
  assert.equal(partial.truncated, true);

  const dup = payload(await tools.bh_compress.execute({ content: original, title: '再来一次' }));
  assert.equal(dup.deduped, true, '同内容去重');
  assert.equal(dup.id, written.id);
  ok('compress → restore 往返一致；分段读正确；同内容去重');
}

// 3. search 与 status
{
  const root = tmpRoot('search');
  const tools = byName(makeBlockTools({ blocksRoot: path.join(root, 'blocks') }));
  payload(await tools.bh_compress.execute({ content: '关于黑洞的一块原文', title: '黑洞笔记', tags: ['黑'] }));
  payload(await tools.bh_compress.execute({ content: '另一块，写的是书同文', title: '书同文笔记' }));

  const hit = payload(await tools.bh_search.execute({ query: '黑洞' }));
  assert.equal(hit.ok, true);
  assert.equal(hit.count, 1);
  assert.equal(hit.hits[0].title, '黑洞笔记');
  assert.ok(hit.hits[0].snippet.length > 0);

  const none = payload(await tools.bh_search.execute({ query: '不存在词' }));
  assert.equal(none.ok, true);
  assert.equal(none.count, 0);

  const st = payload(await tools.bh_status.execute());
  assert.equal(st.ok, true);
  assert.equal(st.blocks, 2);
  assert.equal(st.missing, 0);
  ok('search 命中带 snippet；status 报块数与缺口');
}

// 4. 失败不抛异常
{
  const root = tmpRoot('fail');
  const tools = byName(makeBlockTools({ blocksRoot: path.join(root, 'blocks') }));
  const empty = await tools.bh_compress.execute({ content: '  ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'E_EMPTY');
  assert.equal(typeof empty.message, 'string');
  assert.deepEqual(JSON.parse(tools.bh_compress.output.render({}, empty)[0].text), empty);

  const missing = await tools.bh_restore.execute({ id: 'bhb_20260101_deadbeef' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'E_NOT_FOUND');

  const badId = await tools.bh_restore.execute({ id: '../../etc/passwd' });
  assert.equal(badId.ok, false);
  assert.equal(badId.code, 'E_BAD_ID');

  const emptyQuery = await tools.bh_search.execute({ query: '   ' });
  assert.equal(emptyQuery.ok, false);
  assert.equal(emptyQuery.code, 'E_EMPTY_QUERY');
  ok('失败返回 ok:false + code，不抛异常（E_EMPTY / E_NOT_FOUND / E_BAD_ID / E_EMPTY_QUERY）');
}

// 5. 注册：正常 / 没服务 / 没块仓 / 单个注册失败
{
  const root = tmpRoot('register');
  const config = { blocksRoot: path.join(root, 'blocks') };

  const registered = [];
  const scope = { tools: { register: (spec) => registered.push(spec.name) } };
  const names = registerBlockTools(scope, config);
  assert.deepEqual(names, ['bh_compress', 'bh_restore', 'bh_search', 'bh_status']);
  assert.deepEqual(registered, names);

  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  assert.deepEqual(registerBlockTools({}, config, logger), [], '没有 tools 服务 → 空数组');
  assert.deepEqual(registerBlockTools(scope, {}, logger), [], '没配 blocksRoot/stateRoot → 空数组');
  assert.ok(warnings.length >= 2, '两种情况都记了日志');

  warnings.length = 0;
  let calls = 0;
  const flaky = {
    tools: {
      register: () => {
        calls += 1;
        if (calls === 2) throw new Error('boom');
      },
    },
  };
  const partial = registerBlockTools(flaky, config, logger);
  assert.deepEqual(partial, ['bh_compress', 'bh_search', 'bh_status'], '单个注册失败只跳过它');
  assert.ok(warnings.some((m) => m.includes('boom')));
  ok('注册：正常 4 个；无 tools / 无块仓返回空并记日志；单个失败不影响其余');

  // 带 effect 的 scope（生产环境是 cordis inject 作用域）：注册要包进 effect，卸载时能注销。
  const effects = [];
  const withEffect = {
    effect: (fn) => {
      effects.push(fn);
    },
    tools: { register: () => () => {} },
  };
  const viaEffect = registerBlockTools(withEffect, config, logger);
  assert.deepEqual(viaEffect, ['bh_compress', 'bh_restore', 'bh_search', 'bh_status']);
  assert.equal(effects.length, 4, '每个工具各走一次 effect');
  ok('scope 带 effect 时，四个注册都包在 effect 里（卸载可注销）');
}

// 6. bh_status 带压缩台账（顶上 bili 的 acp_status 那个位置）
{
  const root = tmpRoot('status');
  const stateRoot = path.join(root, 'state');
  const archiveRoot = path.join(root, 'archive');
  const tools = byName(makeBlockTools({ stateRoot, blocksRoot: path.join(root, 'blocks'), archiveRoot }));
  payload(await tools.bh_compress.execute({ content: '一块原文', title: '状态测试' }));
  appendEvent(stateRoot, { type: EVENT_TYPE.ARCHIVED, subject: '压缩归档 1-10' });
  appendEvent(stateRoot, { type: EVENT_TYPE.SKIPPED, subject: '窄段跳过' });
  appendEvent(stateRoot, { type: EVENT_TYPE.FAILED, subject: '归档失败' });
  fs.mkdirSync(path.join(archiveRoot, 'session-x', '2026-11-06'), { recursive: true });
  fs.writeFileSync(path.join(archiveRoot, 'session-x', '2026-11-06', '1-10.md'), 'x'.repeat(123), 'utf8');
  fs.writeFileSync(path.join(archiveRoot, 'session-x', '2026-11-06', '11-20.md.abandoned'), 'y'.repeat(99), 'utf8');

  const st = await tools.bh_status.execute();
  assert.equal(st.compaction.archived, 1);
  assert.equal(st.compaction.skipped, 1);
  assert.equal(st.compaction.failed, 1);
  assert.equal(st.compaction.archiveFiles, 1, '只数 .md，不数 .abandoned');
  assert.equal(st.compaction.archiveBytes, 123);
  assert.ok(st.compaction.lastArchivedAt, '最近归档时间来自 events');
  ok('status 带压缩台账：归档/跳过/失败计数、归档件份数与占用（.abandoned 不计）');
}

console.log(`\n通过 ${passed} 项`);
