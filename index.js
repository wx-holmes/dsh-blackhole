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
import { startHeartbeat } from './src/heartbeat.js';
import { refreshDailyHorizon, resolveDailyHorizon } from './src/rotation.js';
import { registerBlockTools } from './src/tools.js';

export const name = 'dsh-blackhole';

/**
 * 依赖：
 * - llm / tokenMeter / sessions：父类 BasicCompactionEngine 需要的宿主服务。
 * - tools：块仓工具要挂上去。2026-11-06 实测：在 apply 里再 ctx.inject(['tools'], cb)
 *   拿到的 scope 上 tools 是空的，注册静默落空（trace 只有 `block tools registered: (none)`）；
 *   照 tongwen 的写法「inject 里声明 + apply 里直接 ctx.tools.register」才真挂得上。
 */
export const inject = ['llm', 'tokenMeter', 'sessions', 'tools'];

export async function apply(ctx, config = {}) {
  trace(`apply enter: config=${JSON.stringify(config)}`);

  // 视界实验的日轮换（2026-11-07）：按当天日期挑档位，覆盖静态的 thresholdRatio / eventHorizon。
  // 放在最前面：baseConfig 和引擎都从这里的 config 取值，晚一步就会一份新一份旧。
  try {
    const rotation = resolveDailyHorizon(config, new Date(), { solidifyLine: config.solidifyLine });
    if (rotation) {
      config = { ...config, thresholdRatio: rotation.ratio, eventHorizon: rotation.ratio };
      trace(
        `apply: dailyHorizon ${rotation.day} → ${rotation.ratio}` +
          ` (第 ${rotation.dayIndex + 1}/${rotation.plan.length} 档，start ${rotation.start}${rotation.clamped ? '，已夹到固化线下方' : ''})`
      );
    } else if (config.dailyHorizon) {
      trace(`apply: dailyHorizon 存在但今天不生效（start=${config.dailyHorizon?.start}）`);
    }
  } catch (error) {
    trace(`apply: dailyHorizon FAILED ${error?.message ?? error}`);
  }

  // 跨零点自动换档（2026-11-08 03:20 补）：apply 只算一次，00:00 之后不会自己变。
  // 实测坑：当天 0.7 等到 01:17 重启才生效，头 77 分钟还在跑 0.28。
  // 这里每 60 秒按「现在」重算一次，变了就改 config 并留一行 trace。
  try {
    const tick = setInterval(() => {
      try {
        const r = refreshDailyHorizon(config, new Date(), { solidifyLine: config.solidifyLine });
        if (r.changed) {
          trace(`apply: dailyHorizon 换档 ${r.previous} → ${r.ratio}（${r.info?.day}，不重启也生效）`);
        }
      } catch (error) {
        trace(`dailyHorizon tick FAILED ${error?.message ?? error}`);
      }
    }, 60_000);
    tick.unref?.();
    ctx?.effect?.(() => () => clearInterval(tick));
  } catch (error) {
    trace(`apply: dailyHorizon tick 起不来 ${error?.message ?? error}`);
  }

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
  // 以及窄段门槛 minCompactEvents / minCompactTokens、合体字段 events / owner
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
    'maxFoldTokens',
    'fadeTailChars',
    'fadeHeadChars',
    'fadeMinChars',
    'fadeMinSpanTokens',
    'fade',
    'events',
    'owner',
    // A 段（2026-11-06）：块仓与工具前缀——同属黑洞自己的配置，父类不认识
    'blocksRoot',
    'toolPrefix',
    // 视界实验采样（2026-11-07）：同样是黑洞自己的键，父类不认识
    'sampleEveryMs',
    'sampleFile',
    // 冷库（2026-11-07）：billion-context 原文库吸收后的读端目录，父类不认识
    'coldStoreRoot',
    // 按天轮换事件视界（视界实验）——父类不认识
    'dailyHorizon',
    // 按会话覆盖事件视界（2026-11-08，QQ 中枢多步协议单列）——父类不认识
    'sessionRatios',
    // 折叠冷却（2026-11-09，治忙时空追尾折叠）——父类不认识
    'foldCooldownMs',
    'foldCooldownMax',
    // 冷却的两条放行（2026-11-09 23:40：计数落盘后必须留这个口子，否则会憋到硬顶）
    'foldBypassStreak',
    'foldBypassHardCap',
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

  // 心插头（2026-11-07）：trace.log 只在压缩活动时写，夜里空闲会被判「半死」；
  // 心跳必须是定时无条件重写的文件，所以单独起一个 60 秒定时器写 state/heartbeat.json。
  try {
    const beat = startHeartbeat({ stateRoot: config.stateRoot ?? path.join(os.homedir(), '.dsh', 'blackhole', 'state') });
    trace(`apply: heartbeat → ${beat.file}`);
    ctx?.effect?.(() => () => beat.stop());
  } catch (error) {
    trace(`apply: heartbeat FAILED ${error?.message ?? error}`);
  }

  // A 段（2026-11-06）：黑洞自己的块仓 + 压缩工具。
  // tools 服务可能在 apply 时还没加载完，所以用 inject 等它就绪；
  // 注册失败只记日志——压缩主链路不依赖工具。
  try {
    const registered = registerBlockTools(ctx, config, ctx?.logger);
    trace(`apply: block tools registered: ${registered.join(', ') || '(none)'}`);
  } catch (error) {
    trace(`apply: block tools FAILED ${error?.message ?? error}`);
  }
}


