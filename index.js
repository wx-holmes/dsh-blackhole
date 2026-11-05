/**
 * 黑洞插件入口。
 *
 * 定位：@deepseek-ai/dsh-compaction-basic 的替代品。
 * 只覆盖 compactRegion —— 归档 + 压缩同一段历史，原文逐字进 self。
 *
 * 加载顺序（由 cordis.patch.yml 挂载）：
 *   DSH loader → 本文件 apply() → 动态解析 BasicCompactionEngine → 注册为 ctx.compaction
 *
 * 注意：inject 写的是「提供 compaction 服务所需的宿主依赖」（与 compaction-basic 同），
 * 不能写 ['compaction'] —— 那会等一个自己 apply 之后才注册的服务，永远满足不了。
 */
import { ArchiveStore } from './src/archive.js';
import { makeBlackholeEngine, trace } from './src/engine.js';

export const name = 'dsh-blackhole';

/** 压缩后端依赖：llm / tokenMeter / sessions 是父类 BasicCompactionEngine 需要的宿主服务。 */
export const inject = ['llm', 'tokenMeter', 'sessions'];

export async function apply(ctx, config = {}) {
  trace(`apply enter: config=${JSON.stringify(config)}`);

  let Base;
  try {
    ({ default: Base } = await import('@deepseek-ai/dsh-compaction-basic'));
    trace(`apply: Base resolved: ${typeof Base} ${Base?.name ?? ''}`);
  } catch (error) {
    ctx?.logger?.warn?.(
      `blackhole: 解析 @deepseek-ai/dsh-compaction-basic 失败，暂不接管压缩（原文归档保持离线可用）：${error?.message ?? error}`
    );
    trace(`apply: Base resolve FAILED ${error?.message ?? error}`);
    return;
  }

  // 启动恢复：超时 pending 转 abandoned（原文保留），已提交的补清理
  try {
    const store = new ArchiveStore(config);
    const recovered = store.recover();
    trace(`apply: recover committed=${recovered.committed} abandoned=${recovered.abandoned}`);
    if (recovered.abandoned || recovered.committed) {
      ctx?.logger?.info?.(`blackhole: 启动恢复 committed=${recovered.committed} abandoned=${recovered.abandoned}`);
    }
  } catch (error) {
    ctx?.logger?.warn?.(`blackhole: 启动恢复失败（不影响压缩）：${error?.message ?? error}`);
    trace(`apply: recover FAILED ${error?.message ?? error}`);
  }

  // 关键坑（2026-11-05 实测）：BasicCompactionEngine 的 resolveConfig 用 validateKeys 白名单校验，
  // 遇到不认识的键直接抛 `BasicCompactionConfig: unknown key "..."`。黑洞自己的
  // eventHorizon / solidifyLine / hardCap / archiveRoot / stateRoot / pendingTtlMs
  // 以及窄段门槛 minCompactEvents / minCompactTokens
  // 必须先剥掉再交给父类，否则 Engine 构造抛错、compaction 服务静默没人提供，
  // 表面看「插件 active」但永远不压缩。
  const BLACKHOLE_ONLY_KEYS = new Set([
    'eventHorizon',
    'solidifyLine',
    'hardCap',
    'archiveRoot',
    'stateRoot',
    'pendingTtlMs',
    'minCompactEvents',
    'minCompactTokens',
  ]);
  const baseConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (!BLACKHOLE_ONLY_KEYS.has(key)) baseConfig[key] = value;
  }
  trace(`apply: baseConfig=${JSON.stringify(baseConfig)}`);

  const Engine = makeBlackholeEngine(Base, config);
  try {
    ctx.plugin(Engine, baseConfig);
    trace('apply: ctx.plugin(Engine) OK');
  } catch (error) {
    trace(`apply: ctx.plugin(Engine) THREW ${error?.message ?? error}`);
    throw error;
  }
}
