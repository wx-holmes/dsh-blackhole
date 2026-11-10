/**
 * 黑洞自己的压缩工具（A 段）：compress / restore / search_context 的自家版。
 *
 * 名字暂时带 `bh_` 前缀——billion-context 还在跑，它占着 compress / decompress /
 * search_context 这四个名字。等 B/C 段把它摘掉，把 config.toolPrefix 改成 ''
 * 就能顶到原名字上（同一份实现，不改代码）。
 *
 * 失败处理原则（比 bili 强的地方）：任何失败都返回 `{ ok: false, code, message }`，
 * 不抛异常、不无限重试、不假装成功——工具层拿到的是可判断的结果。
 *
 * 2026-11-06 23:0x 修：DSH 的 ToolDefinition 里 `output: { schema, render }` 是**必填**，
 * 缺了它 register() 直接抛错（错误被 cordis 吞掉，外层只看到注册数为 0，
 * trace 里就是 `block tools registered: (none)`）。同症状的还有 self-persona——
 * 它也没给 output，所以 self_persona_status 一直不在工具表里。
 * 现在 execute 返回纯 JSON 值，由 output.render 渲染成 content block。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BlockStore, BlockStoreError, DEFAULT_READ_LIMIT } from './blocks.js';
import { ColdStore, ColdStoreError } from './coldstore.js';
import { EVENT_TYPE, appendEvent, eventsPath, readEvents } from './events.js';

const render = (_args, value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
];

/** 四个工具共用的输出定义（DSH ToolDefinition 的必填字段）。 */
const output = { schema: { type: 'object' }, render };

function failure(error) {
  const code = error instanceof BlockStoreError || error instanceof ColdStoreError ? error.code : 'E_INTERNAL';
  const message = String(error?.message ?? error);
  return { ok: false, code, message };
}

/** 冷库默认位置：与吸收脚本的落点一致；可用 coldStoreRoot 覆盖。 */
export const DEFAULT_COLD_STORE = '';  // 空 = 用配置里的 coldStoreRoot（见 cordis.patch.yml）

/**
 * 压缩台账（补 bili 的 acp_status 那个位置）：events 里的归档/跳过/失败计数、
 * 最近一次归档时间，以及 self 档里归档件的份数与占用。
 *
 * 为什么放在 bh_status 里而不是单独开工具：bili 的 acp_status 本质就是「看一眼
 * 压缩跑得怎么样」，黑洞这边状态工具已经承担这个角色，多一个名字只是多占一个名额。
 * 读不到就返回 null —— 统计失败不能拖累状态查询本身。
 */
function compactionStats(config = {}) {
  const stateRoot = config.stateRoot;
  if (!stateRoot) return null;
  const counts = { archived: 0, skipped: 0, failed: 0 };
  let lastArchivedAt = null;
  for (const event of readEvents(stateRoot)) {
    const type = event?.type;
    if (type === EVENT_TYPE.ARCHIVED) {
      counts.archived += 1;
      if (event.ts) lastArchivedAt = event.ts;
    } else if (type === EVENT_TYPE.SKIPPED) {
      counts.skipped += 1;
    } else if (type === EVENT_TYPE.FAILED) {
      counts.failed += 1;
    }
  }

  let archiveFiles = 0;
  let archiveBytes = 0;
  const root = config.archiveRoot;
  if (root && fs.existsSync(root)) {
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.endsWith('.abandoned')) {
          archiveFiles += 1;
          try {
            archiveBytes += fs.statSync(full).size;
          } catch {
            // 单个文件读不到就跳过：统计是附加信息，不值得为它失败。
          }
        }
      }
    }
  }

  return { ...counts, lastArchivedAt, archiveFiles, archiveBytes, events: eventsPath(stateRoot) };
}

export function makeBlockTools(config = {}) {
  const stateRoot = config.stateRoot;
  const prefix = config.toolPrefix == null ? 'bh' : String(config.toolPrefix);
  const name = (base) => (prefix ? `${prefix}_${base}` : base);
  const store = new BlockStore({ stateRoot, blocksRoot: config.blocksRoot });

  return [
    {
      name: name('compress'),
      description:
        '把一段原文压成摘要：原文逐字存到黑洞自己的仓（默认 <stateRoot>/blocks），返回块 id 与摘要，之后可 restore 取回。不依赖外部服务。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要压缩的原文' },
          title: { type: 'string', description: '给这块起的名字（默认取首行）' },
          summary: { type: 'string', description: '可选：你自己写好的摘要；不传则用抽取式摘要' },
          source: { type: 'string', description: '来源标记（会话 id / 文件名）' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，便于以后筛' },
        },
        required: ['content'],
      },
      output,
      timeoutMs: 20000,
      async execute(args = {}) {
        try {
          const meta = store.put({
            content: args.content,
            title: args.title,
            summary: args.summary,
            source: args.source,
            tags: args.tags,
          });
          return { ok: true, ...meta };
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: name('restore'),
      description: '按块 id 取回原文（可分段）。块不存在时返回 ok:false + E_NOT_FOUND，不抛异常。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '块 id（bhb_YYYYMMDD_xxxxxxxx）' },
          offset: { type: 'number', description: '从第几个字符开始（默认 0）' },
          limit: { type: 'number', description: `一次最多取多少字符（默认 ${DEFAULT_READ_LIMIT}）` },
        },
        required: ['id'],
      },
      output,
      timeoutMs: 20000,
      async execute(args = {}) {
        try {
          return { ok: true, ...store.read(args.id, { offset: args.offset, limit: args.limit }) };
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: name('search'),
      description: '在黑洞块库里按关键词搜（标题/摘要/标签计分；full=true 时再扫原文）。返回命中的块 id 与片段。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，空格分隔多个' },
          limit: { type: 'number', description: '最多几条（默认 8）' },
          full: { type: 'boolean', description: '命中不足时是否扫原文（慢一些）' },
          source: { type: 'string', description: '只看某个来源' },
        },
        required: ['query'],
      },
      output,
      timeoutMs: 30000,
      async execute(args = {}) {
        try {
          const hits = store.search(args.query, { limit: args.limit, full: Boolean(args.full), source: args.source });
          return { ok: true, count: hits.length, hits };
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: name('restore_span'),
      description:
        '从冷库（billion-context 原文库吸收进来的归档）按「会话 + seq 区间」取回原文。每片解压后校验 sha256，对不上报 E_CORRUPT。不传 session 时列出冷库里有哪些会话。',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: '会话 id 或唯一前缀；省略则列会话清单' },
          from: { type: 'number', description: '起始 seq（含）' },
          to: { type: 'number', description: '结束 seq（含，默认等于 from）' },
          maxChars: { type: 'number', description: '最多返回多少字符（默认不限；给值时可能截断，truncated=true）' },
          query: { type: 'string', description: '可选：这次召回是为了回答什么（写进 recall.hit 事件，便于评测归因）' },
          caller: { type: 'string', description: '可选：调用方名字（如「书同文」「意识」）；插件拿不到调用方身份，只能谁调谁填' },
        },
        required: [],
      },
      output,
      timeoutMs: 30000,
      async execute(args = {}) {
        try {
          const store = new ColdStore({ root: config.coldStoreRoot || DEFAULT_COLD_STORE });
          if (!args.session) {
            const sessions = store.sessions();
            return { ok: true, root: store.root, count: sessions.length, sessions };
          }
          const startedAt = Date.now();
          const span = store.readSpan(args);
          const latencyMs = Date.now() - startedAt;
          // recall.hit（2026-11-08 加，书同文评测口径）：一次取回 = 一次「被用到」。
          // 失败不影响返回；事件丢了也不能让召回失败。
          if (config.stateRoot) {
            try {
              appendEvent(config.stateRoot, {
                type: EVENT_TYPE.RECALL_HIT,
                subject: `召回 ${span.session} ${span.from}-${span.to}`,
                payload: {
                  session: span.session,
                  seqFrom: span.from,
                  seqTo: span.to,
                  query: args.query ?? '',
                  caller: args.caller ?? '',
                  bytes: span.bytes,
                  digest: span.digest,
                  latencyMs,
                  truncated: span.truncated,
                },
              });
            } catch {
              // 事件写不进就算了，召回结果照样返回。
            }
          }
          return { ok: true, latencyMs, ...span };
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: name('status'),
      description:
        '黑洞现状：块仓（块数/占用/丢没丢原文/坏索引）+ 压缩台账（归档/跳过/失败次数、最近归档时间、self 档归档件份数与占用）。只读。',
      parameters: { type: 'object', properties: {} },
      output,
      timeoutMs: 15000,
      async execute() {
        try {
          return { ok: true, ...store.status(), compaction: compactionStats(config) };
        } catch (error) {
          return failure(error);
        }
      },
    },
  ];
}

/**
 * 把工具挂到 ctx.tools 上。tools 服务没就绪时由调用方用 ctx.inject(['tools']) 包住。
 * 任一工具注册失败只记日志，不影响其余工具，也不影响压缩主链路。
 */
export function registerBlockTools(scope, config = {}, logger = null) {
  if (!scope?.tools?.register) {
    logger?.warn?.('blackhole: tools 服务不在，跳过块工具注册（不影响压缩）');
    return [];
  }
  // 块仓构造失败（没配 stateRoot / blocksRoot）也只跳过工具，不能把 apply() 带崩。
  let specs;
  try {
    specs = makeBlockTools(config);
  } catch (error) {
    logger?.warn?.(`blackhole: 块仓初始化失败，跳过块工具（不影响压缩）：${error?.message ?? error}`);
    return [];
  }
  const registered = [];
  // 生产环境里 scope 是 cordis 的 inject 作用域，带 effect()：注册动作要包在 effect 里，
  // 插件卸载时才会自动注销工具（self-persona 用的就是这个写法）。
  // 测试里的假 scope 没有 effect，直接注册即可。
  const useEffect = typeof scope.effect === 'function';
  for (const spec of specs) {
    try {
      if (useEffect) {
        // effect 的返回值按 cordis 约定要是 disposer；register 若返回 void，补一个空函数，
        // 免得 effect 直接抛「必须返回 disposer」把注册吞掉。
        scope.effect(() => {
          const disposer = scope.tools.register(spec);
          return typeof disposer === 'function' ? disposer : () => {};
        });
      } else {
        scope.tools.register(spec);
      }
      registered.push(spec.name);
    } catch (error) {
      logger?.warn?.(`blackhole: 注册工具 ${spec.name} 失败：${error?.message ?? error}`);
    }
  }
  return registered;
}

