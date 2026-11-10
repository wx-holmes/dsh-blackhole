import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore } from './archive.js';
import { appendCardIndex } from './cards.js';
import { appendEvent, EVENT_TYPE } from './events.js';
import { commitRegion, stageRegion, today } from './region.js';
import { fadeRange, resolveFadeConfig } from './fade.js';
import { HORIZON_DEFAULTS } from './horizon.js';

/**
 * 排查用：插件在 DSH 进程里看不到 stdout（看门狗 stdio:'ignore'），只能自己落文件。
 *
 * 路径可用环境变量 BLACKHOLE_TRACE 覆盖——测试必须指到临时文件，
 * 否则每跑一次单测就往生产 trace.log 里塞几行假数据（2026-11-06 踩过）。
 */
const DEFAULT_TRACE_FILE = path.join(os.tmpdir(), 'dsh-blackhole-trace.log');
const DEFAULT_SAMPLE_FILE = path.join(os.tmpdir(), 'dsh-blackhole-surface.jsonl');

export function traceFilePath() {
  const custom = process.env?.BLACKHOLE_TRACE;
  return typeof custom === 'string' && custom.length > 0 ? custom : DEFAULT_TRACE_FILE;
}

export function sampleFilePath() {
  const custom = process.env?.BLACKHOLE_SAMPLE;
  return typeof custom === 'string' && custom.length > 0 ? custom : DEFAULT_SAMPLE_FILE;
}

export function trace(line) {
  try {
    appendFileSync(traceFilePath(), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* 排查日志失败不能影响压缩 */
  }
}

/**
 * 黑洞引擎：继承 BasicCompactionEngine，只覆盖 compactRegion。
 *
 * 为什么覆盖 compactRegion 而不是 summarize：
 * - summarize(input, agent, signal) 拿不到「压的是哪一段」；
 * - compactRegion(start, end, agent, signal) 直接给范围，且 compactIfNeeded 走 this.compactRegion。
 *
 * 顺序：先归档（staging→pending），再让父类压缩（摘要+替换），成功后才 commit。
 * 父类失败 → abandon，原文保留。
 *
 * 窄段门槛（2026-11-05 加）：父类 selectCompactableRange 永远只取「前缀」，
 * 前缀很窄时（典型：只剩 1 个事件）摘要几乎不可能比原文短，父类会抛
 * `summary is not smaller than the shadowed content`，白烧一次摘要调用 + 留一份废弃件。
 * trace.log 里 27 次失败有 17 次是单事件段，且同一序号等段变宽后再压就成功。
 * 所以在归档和调摘要器之前先量一下这一段的宽窄，太窄就跳过，等它自然变宽。
 */
export function makeBlackholeEngine(Base, options = {}) {
  return class BlackholeEngine extends Base {
    constructor(ctx, config = {}) {
      super(ctx, config);
      this.archive = new ArchiveStore({
        archiveRoot: options.archiveRoot,
        stateRoot: options.stateRoot,
        pendingTtlMs: options.pendingTtlMs,
      });
      this.blackhole = { archived: 0, failed: 0, skipped: 0 };
      // 窄段门槛：事件数 < minCompactEvents 或 tokens < minCompactTokens 就不压
      this.limits = {
        minCompactEvents: Number(options.minCompactEvents ?? 2),
        minCompactTokens: Number(options.minCompactTokens ?? 2000),
        // 单次折叠上限（2026-11-07）：一次摘要调用读不完的段（>35 万 token）会被模型拒绝，
        // 导致「压缩失败 → 会话卡在超长状态」。超了就只折最老的一段，剩下的下一轮再折。
        maxFoldTokens: Number(options.maxFoldTokens ?? 350000),
        // 先剪后折（2026-11-07）：折叠前把这一段里的老工具输出剪成头+尾+标记。
        // 不花模型，摘要要读的 token 直接少三到五成。归档在剪之前，原文不受影响。
        fade: options.fade !== false,
        fadeMinSpanTokens: Number(options.fadeMinSpanTokens ?? 60000),
        fadeConfig: resolveFadeConfig(options),
      };
      this._skippedThisCall = 0;
      // 视界实验采样（2026-11-07）：每轮顺手记一行「这个时空当时在多大的盘子里干活」。
      // 零模型调用、只追加文件；按 sampleEveryMs 每时空节流，折叠发生时必记一笔。
      this.sample = {
        file: sampleFilePath(),
        everyMs: Number(options.sampleEveryMs ?? 60000),
        last: new Map(),
      };
      // 按会话覆盖事件视界（2026-11-08，主人 11:09 点头的选项 1）：
      // 多步协议的时空（QQ 中枢一回复要 2~3 次模型往返，每次都重带整段上下文）
      // 对上下文大小比单步协议敏感得多，所以给它单独一个更低的档位。
      // 配置形状：sessionRatios: { "<session id 或唯一前缀>": 0.5 }
      // 只影响 thresholdRatio/eventHorizon，父类其余行为不变；不匹配就走全局档位。
      this.sessionRatios = Object.create(null);
      const rawRatios = options.sessionRatios ?? {};
      if (rawRatios && typeof rawRatios === 'object') {
        for (const [key, value] of Object.entries(rawRatios)) {
          const ratio = Number(value);
          const id = String(key ?? '').trim();
          // 只接受 (0,1) 的数；solidifyLine 以上没有意义（折叠永远等不到），直接跳过并留痕。
          if (!id || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
            if (id) trace(`sessionRatios: 忽略非法档位 ${id}=${value}`);
            continue;
          }
          const ceiling = Number(options.solidifyLine ?? HORIZON_DEFAULTS.solidifyLine) - 0.01;
          const clamped = Math.min(ratio, ceiling);
          this.sessionRatios[id.toLowerCase()] = clamped;
          if (clamped !== ratio) trace(`sessionRatios: ${id} ${ratio} 超过 solidifyLine，降到 ${clamped.toFixed(2)}`);
        }
      }
      this._configBeforeOverride = null;
      // 折叠冷却（2026-11-09，主人 02:47 点头）：同一会话在窗口内最多折 N 次，
      // 超了就这一轮不折、等下一轮。治的是「折一段 30k、几分钟就长回来」的追尾——
      // 11-09 实测 1b80e3aa 15 分钟折 5 次，表面一直卡在 353~385k，纯烧摘要。
      // 窗口 0 或次数 0 = 关掉（默认开：10 分钟 2 次）。
      // 不做全局熔断：每个时空自己的节奏不同，一个忙时空不该拖住别人。
      // 2026-11-09 23:40 加固：计数落盘跨重启（今天重载 22 次，每次都把窗口清零，
      // 等于「重启就多给两次」），但**必须配两条放行**，否则会话被拦久了会一路长到硬顶。
      // 放行条件：连续被拦 >= bypassStreak 次，或 tokens 已到硬顶的 bypassHardCap 倍。
      this.foldGuard = {
        windowMs: Math.max(0, Number(options.foldCooldownMs ?? 600000)),
        max: Math.max(0, Math.trunc(Number(options.foldCooldownMax ?? 2))),
        bypassStreak: Math.max(1, Math.trunc(Number(options.foldBypassStreak ?? 8))),
        bypassHardCap: Math.min(1, Math.max(0.5, Number(options.foldBypassHardCap ?? 0.95))),
        hits: new Map(),
        streak: new Map(),
        persistFile: path.join(this.archive?.stateRoot ?? '.', 'foldguard.json'),
        loaded: false,
      };
      this._loadFoldGuard();
      // 合体：往 <stateRoot>/events.jsonl 写器官事件，供书同文读进账本（联动契约 §2.2）。
      // 路径必须与 organ.json 的 events.path 一致；写失败只记 trace，绝不影响压缩。
      // owner：这个 profile 属于哪个项目/时空（合体接入清单 §五②）。黑洞是一个 profile 一实例、
      // 服务所有会话，所以它只能填「整份 profile 的归属」；具体某个会话属于哪个项目，
      // 书同文用自己的白板参与者列表（session id 就在 payload.session 里）反查，不靠黑洞猜。
      this.events = {
        stateRoot: this.archive.stateRoot,
        enabled: options.events !== false,
        owner: options.owner == null || options.owner === '' ? null : String(options.owner),
      };
      // 构造完才知道 config 到底解析成什么（这是判断阈值是否生效的第一现场）
      try {
        const c = this.config ?? {};
        trace(
          `constructor: auto=${c.auto} thresholdRatio=${c.thresholdRatio} retainRatio=${c.retainRatio} ` +
            `retainTokens=${c.retainTokens} headroomTokens=${c.headroomTokens} archiveRoot=${this.archive?.archiveRoot}`
        );
      } catch (error) {
        trace(`constructor trace failed: ${error?.message ?? error}`);
      }
    }

    /**
     * 只加观测、不改行为：父类 compactIfNeeded 内部有太多静默 return null 的岔路
     * （routedTarget 缺失 / 没有 contextWindow / 低于阈值 / 选不出范围），
     * 全都要一条日志才能定位。
     */
    async compactIfNeeded(agent, trigger, signal) {
      const startedAt = Date.now();
      const session = agent?.session;
      let measurement = null;
      this._skippedThisCall = 0;
      // 这一轮到底折成了没有：整轮可能以「等段变宽」收场（父类抛 still above threshold），
      // 但中途已经折过一段——那种也必须落一行采样，否则视界实验会漏记真实折叠。
      this._foldedThisCall = false;
      // 这一轮里成功折了几段：一次 compactIfNeeded 里父类会重试多次，每段各归档一次。
      // 记账要能把「19 轮折叠」和「119 段归档」对上，靠的就是这个数。
      this._foldSegmentsThisCall = 0;
      this._lastFold = null;
      try {
        trace(`ifNeeded enter: trigger=${trigger} session=${session?.id ?? '?'} aborted=${signal?.aborted}`);

        // 1) 路由目标（拿不到就直接 return null，是最常见的静默分支）
        try {
          const header = session?.requestHeader?.();
          trace(`  header: ${JSON.stringify(header?.config ?? null)}`);
          const rc = session?.requestContext?.();
          trace(`  requestContext: ${JSON.stringify(rc ?? null)}`);
        } catch (error) {
          trace(`  header read failed: ${error?.message ?? error}`);
        }

        // 2) 当前估算占用（measurement 提出 try，视界实验采样要用）
        try {
          const meter = this.ctx?.tokenMeter;
          measurement = meter?.measure?.(session) ?? null;
          // 缓存一份：真正开始压缩后（父类持锁/写标记）再 measure 会抛，spanStats 就量不到，
          // 2026-11-07 实测 c73c785e 因此一直跳过了收窄逻辑。
          this._measurement = measurement;
          trace(`  measurement: ${JSON.stringify(measurement ?? null)}`);
        } catch (error) {
          trace(`  measure failed: ${error?.message ?? error}`);
        }

        // 3) 阈值实际取了多少
        try {
          trace(
            `  config: thresholdRatio=${this.config?.thresholdRatio} retainRatio=${this.config?.retainRatio} ` +
              `headroomTokens=${this.config?.headroomTokens} auto=${this.config?.auto}`
          );
        } catch (error) {
          trace(`  config read failed: ${error?.message ?? error}`);
        }
      } catch {
        /* 观测失败不拦主流程 */
      }

      // 4) 按会话覆盖档位（2026-11-08）：命中就在 this.config 上临时改阈值，
      //    super 读的是 this.config，改它才真的让父类按新档位判；finally 里一定还原。
      try {
        const effectiveRatio = this._ratioFor(session?.id);
        if (effectiveRatio != null) {
          const base = this.config ?? {};
          if (Number(base.thresholdRatio) !== effectiveRatio) {
            this._configBeforeOverride = base;
            this.config = { ...base, thresholdRatio: effectiveRatio, eventHorizon: effectiveRatio };
            trace(`  sessionRatios: ${session?.id} 用 ${effectiveRatio}（全局 ${base.thresholdRatio}）`);
          }
        }
      } catch (error) {
        trace(`  sessionRatios apply failed: ${error?.message ?? error}`);
      }

      // 4.5) 折叠冷却（2026-11-09）：这个会话在窗口内已经折够了，就这一轮不折。
      //     只跳过、不改阈值、不报错——下一轮窗口滑过就自动恢复。
      //     2026-11-09 23:40：计数落盘跨重启；被拦太久或已贴硬顶会放行（见 _foldBlocked）。
      try {
        const guardTokens = Number(measurement?.baseline?.tokens ?? measurement?.tokens ?? 0) || 0;
        let guardWindow = 0;
        try {
          guardWindow = Number(session?.requestContext?.()?.contextWindow ?? 0) || 0;
        } catch (error) {
          guardWindow = 0;
        }
        if (this._foldBlocked(session?.id, { tokens: guardTokens, windowTokens: guardWindow })) {
          trace(
            `  foldGuard: ${session?.id} 冷却中（${this.foldGuard.max} 次 / ${this.foldGuard.windowMs}ms，` +
              `连续第 ${this.foldGuard.streak.get(session?.id) ?? 0} 次），这一轮不折`
          );
          this._sampleSurface(session, trigger, measurement, false, Date.now() - startedAt);
          return null;
        }
      } catch (error) {
        trace(`  foldGuard check failed: ${error?.message ?? error}`);
      }

      try {
        const result = await super.compactIfNeeded(agent, trigger, signal);
        trace(
          `ifNeeded exit: trigger=${trigger} result=${result ? 'COMPACTED' : 'null'} ms=${Date.now() - startedAt}`
        );
        this._sampleSurface(session, trigger, measurement, result != null || this._foldedThisCall, Date.now() - startedAt);
        // 真折过才记一笔冷却账（父类返回 null 且本轮没折 = 没花摘要钱）
        if (result != null || this._foldedThisCall) this._recordFold(session?.id);
        return result;
      } catch (error) {
        const message = error?.message ?? String(error);
        // 父类重试用尽后会抛「还是压不下去」。如果这一轮被我们跳过的全是窄段，
        // 那这次的“压不下去”是主动选择（等段变宽），不是故障，不该往上冒。
        if (this._skippedThisCall > 0 && /still above threshold/i.test(message)) {
          trace(
            `ifNeeded: ${this._skippedThisCall} 次窄段跳过，父类报阈值未降，按「等段变宽」处理：${message}`
          );
          this._sampleSurface(session, trigger, measurement, this._foldedThisCall, Date.now() - startedAt);
          if (this._foldedThisCall) this._recordFold(session?.id);
          return null;
        }
        trace(
          `ifNeeded threw: trigger=${trigger} name=${error?.name} msg=${message} ms=${Date.now() - startedAt}`
        );
        throw error;
      } finally {
        // 无论成功、失败还是抛错，按会话覆盖都要还原——否则下一个时空会继承别人的档位。
        if (this._configBeforeOverride) {
          this.config = this._configBeforeOverride;
          this._configBeforeOverride = null;
        }
      }
    }

    /** 命中哪个会话的覆盖档位；不命中返回 null（走全局档位）。前缀匹配取最长的那条。 */
    _ratioFor(sessionId) {
      const id = String(sessionId ?? '').toLowerCase();
      if (!id) return null;
      let best = null;
      let bestLen = -1;
      for (const [key, ratio] of Object.entries(this.sessionRatios ?? {})) {
        if (!key) continue;
        if ((id === key || id.startsWith(key)) && key.length > bestLen) {
          best = ratio;
          bestLen = key.length;
        }
      }
      return best;
    }

    /** 从磁盘读回窗口计数：只有同一套 windowMs/max 才认，配置改了就当没写过。 */
    _loadFoldGuard() {
      const g = this.foldGuard;
      if (!g || g.windowMs <= 0 || g.max <= 0 || !g.persistFile) return;
      try {
        if (!existsSync(g.persistFile)) return;
        const raw = JSON.parse(readFileSync(g.persistFile, 'utf8'));
        if (raw?.windowMs !== g.windowMs || raw?.max !== g.max) {
          trace(`foldGuard: 落盘配置 ${raw?.windowMs}/${raw?.max} 与当前 ${g.windowMs}/${g.max} 不符，忽略旧账`);
          return;
        }
        const now = Date.now();
        let kept = 0;
        for (const [id, list] of Object.entries(raw?.hits ?? {})) {
          if (!id || !Array.isArray(list)) continue;
          const hits = list.map(Number).filter((ts) => Number.isFinite(ts) && now - ts < g.windowMs).slice(-32);
          if (hits.length) {
            g.hits.set(id, hits);
            kept += 1;
          }
        }
        for (const [id, n] of Object.entries(raw?.streak ?? {})) {
          const v = Math.trunc(Number(n));
          if (id && Number.isFinite(v) && v > 0) g.streak.set(id, v);
        }
        g.loaded = true;
        trace(`foldGuard: 载入 ${kept} 个会话的窗口计数（跨重启续账）`);
      } catch (error) {
        trace(`foldGuard: 载入失败（按空账跑）${error?.message ?? error}`);
      }
    }

    /** 把窗口计数写回磁盘。只在拦截/真折/放行时写，一次几 KB，不节流。 */
    _persistFoldGuard() {
      const g = this.foldGuard;
      if (!g || g.windowMs <= 0 || g.max <= 0 || !g.persistFile) return;
      try {
        const hits = {};
        for (const [id, list] of g.hits) if (Array.isArray(list) && list.length) hits[id] = list.slice(-32);
        const streak = {};
        for (const [id, n] of g.streak) if (n > 0) streak[id] = n;
        mkdirSync(path.dirname(g.persistFile), { recursive: true });
        writeFileSync(
          g.persistFile,
          JSON.stringify({ v: 1, windowMs: g.windowMs, max: g.max, savedAt: Date.now(), hits, streak }),
          'utf8'
        );
      } catch (error) {
        trace(`foldGuard: 落盘失败 ${error?.message ?? error}`);
      }
    }

    /**
     * 这个会话在冷却窗口内折够了吗？关掉时（窗口或上限为 0）永远返回 false。
     * 2026-11-09 加固：被拦住时累计 streak；连续拦够次数、或 tokens 已贴硬顶，就放行这一轮，
     * 免得重启后还一直拦，把会话憋到上下文溢出。
     */
    _foldBlocked(sessionId, { tokens = 0, windowTokens = 0 } = {}) {
      const g = this.foldGuard;
      if (!g || g.windowMs <= 0 || g.max <= 0) return false;
      const id = String(sessionId ?? '');
      if (!id) return false;
      const now = Date.now();
      const hits = (g.hits.get(id) ?? []).filter((ts) => now - ts < g.windowMs);
      if (hits.length === 0) {
        g.hits.delete(id);
        g.streak.delete(id);
        return false;
      }
      g.hits.set(id, hits);
      if (hits.length < g.max) {
        g.streak.delete(id);
        return false;
      }

      const streak = (g.streak.get(id) ?? 0) + 1;
      g.streak.set(id, streak);
      const hardCap = Number(this.config?.hardCap ?? HORIZON_DEFAULTS.hardCap);
      const capTokens = windowTokens > 0 ? Math.round(windowTokens * hardCap * g.bypassHardCap) : 0;
      const byTokens = capTokens > 0 && tokens >= capTokens;
      const byStreak = streak >= g.bypassStreak;
      if (byTokens || byStreak) {
        trace(
          `  foldGuard: ${id} 放行（连续被拦 ${streak} 次 / tokens=${tokens}` +
            `${capTokens ? ` ≥ ${capTokens}` : ''}）——宁可多折一次，也不憋到硬顶`
        );
        g.hits.delete(id);
        g.streak.delete(id);
        this._persistFoldGuard();
        return false;
      }
      this._persistFoldGuard();
      return true;
    }

    /** 记一次折叠。只在真折过之后调用；窗口内旧的记录顺手清掉，Map 不会越滚越大。 */
    _recordFold(sessionId) {
      const g = this.foldGuard;
      if (!g || g.windowMs <= 0 || g.max <= 0) return;
      const id = String(sessionId ?? '');
      if (!id) return;
      const now = Date.now();
      const hits = (g.hits.get(id) ?? []).filter((ts) => now - ts < g.windowMs);
      hits.push(now);
      g.hits.set(id, hits);
      g.streak.delete(id);
      this._persistFoldGuard();
    }

    /**
     * 视界实验采样：每个时空每轮经过这里，记录当时表面多大。
     * folded=true（这一轮真折过）必记；平时按 everyMs 节流，避免 QQ 时空一天几千行。
     * 四个折叠字段（foldMs/foldTokens/faded/charsSaved）只在这一轮折过时有意义，其余落 null。
     */
    _sampleSurface(session, trigger, measurement, folded, ms) {
      try {
        const s = this.sample;
        if (!s?.file) return;
        const id = session?.id ?? 'unknown';
        const now = Date.now();
        const didFold = folded === true;
        const prev = s.last.get(id) ?? 0;
        if (!didFold && now - prev < s.everyMs) return;
        s.last.set(id, now);
        const tokens = Number(measurement?.baseline?.tokens ?? measurement?.tokens ?? 0) || 0;
        const fold = didFold ? this._lastFold ?? null : null;
        const row = {
          ts: now,
          day: new Date(now + 8 * 3600e3).toISOString().slice(0, 10),
          at: new Date(now + 8 * 3600e3).toISOString().slice(11, 19),
          session: id,
          trigger: String(trigger ?? ''),
          tokens,
          threshold: Number(this.config?.thresholdRatio ?? 0),
          retain: Number(this.config?.retainRatio ?? 0),
          folded: didFold,
          foldSegments: didFold ? (this._foldSegmentsThisCall ?? 0) : 0,
          foldMs: fold?.ms ?? null,
          foldTokens: fold?.tokens ?? null,
          faded: fold?.faded ?? 0,
          charsSaved: fold?.charsSaved ?? 0,
          ms,
        };
        mkdirSync(path.dirname(s.file), { recursive: true });
        appendFileSync(s.file, JSON.stringify(row) + '\n', 'utf8');
      } catch (error) {
        trace(`sample failed: ${error?.message ?? error}`);
      }
    }

    /**
     * 把一段过宽的前缀收窄到 budget 以内，返回新的区间终点 seq；收不了就返回 null。
     *
     * 为什么需要：父类 selectCompactableRange 只取前缀，长会话前缀可能超过一次摘要调用能读的量
     * （2026-11-07 实测 session-c73c785e 114.9 万 token，摘要请求 189 万 token → 模型直接拒绝，
     * 压缩永远失败、会话卡在「对话太长」）。收窄后变成「折最老的一段 → 下一轮再折一段」。
     *
     * 切点只在工具调用/结果配平的位置（balance == 0），避免把 tool/call 和 tool/result 拆开。
     */
    cutRange(session, start, end, budget) {
      try {
        const nodes = this.nodesOf(session);
        if (!Array.isArray(nodes) || nodes.length === 0) return null;
        const startIdx = nodes.findIndex((node) => node?.seq === Number(start));
        if (startIdx <= 0) return null;
        // 与宿主完全一致的配平口径（dsh-compaction/tool-pairing）：
        //   assistant/message 的 tool-call 块 +1，tool/result -1，其余 0；
        //   「切在某节点之后」合法 ⟺ 此刻未完成的工具调用数为 0。
        const deltaOf = (seq) => {
          try {
            const event = session?.eventAt?.(seq);
            if (!event) return 0;
            if (event.type === 'tool/result') return -1;
            if (event.type === 'assistant/message') {
              const content = event?.data?.message?.content ?? [];
              return Array.isArray(content)
                ? content.filter((block) => block?.type === 'tool-call').length
                : 0;
            }
            return 0;
          } catch {
            return 0;
          }
        };
        let open = 0;
        for (let i = 0; i < startIdx; i += 1) open += deltaOf(Number(nodes[i]?.seq));
        let acc = 0;
        let boundaries = 0;
        let firstAtOrAfterBudget = null;
        let lastBelowBudget = null;
        for (let i = startIdx; i < nodes.length; i += 1) {
          const seq = Number(nodes[i]?.seq);
          acc += Number(nodes[i]?.tokens ?? 0);
          open += deltaOf(seq);
          if (seq === Number(end)) break; // 走到头也没超预算，不用收窄
          if (open !== 0 || seq === Number(start)) continue;
          boundaries += 1;
          if (acc >= budget) {
            firstAtOrAfterBudget = seq;
            break;
          }
          lastBelowBudget = seq;
        }
        // 预算之后第一个合法边界；没有就退一步，用预算内最后一个合法边界（尽量多折一点，哪怕不够 35 万）。
        const chosen = firstAtOrAfterBudget ?? lastBelowBudget;
        trace(
          `cutRange: start=${start} end=${end} budget=${budget} boundaries=${boundaries} chosen=${chosen ?? 'null'}`
        );
        return chosen ?? null;        return null;
      } catch {
        return null;
      }
    }

    /** 取当前 surface 的节点表：优先用 compactIfNeeded 入口缓存的测量结果（压缩期间现测会失败）。 */
    nodesOf(session) {
      try {
        const cached = this._measurement?.nodes;
        if (Array.isArray(cached) && cached.length > 0) return cached;
        return this.ctx?.tokenMeter?.measure?.(session)?.nodes ?? null;
      } catch {
        return null;
      }
    }

    /**
     * 量一段区间的宽窄：事件数 + token 数（口径与父类一致，都用 tokenMeter 的 pricing）。
     * 拿不到 measurement 就返回 null，表示「不知道，别拦」。
     */
    spanStats(session, start, end) {
      try {
        const nodes = this.nodesOf(session);
        if (!Array.isArray(nodes) || nodes.length === 0) return null;
        // surface 是按位置排的，seq 不一定单调（压缩摘要节点带最新 seq 却插在前面），
        // 所以先按位置找两端；找不到才退回数字区间。
        const startIdx = nodes.findIndex((node) => node?.seq === Number(start));
        const endIdx = nodes.findIndex((node) => node?.seq === Number(end));
        const slice =
          startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx
            ? nodes.slice(startIdx, endIdx + 1)
            : nodes.filter((node) => {
                const seq = node?.seq;
                return Number.isFinite(seq) && seq >= start && seq <= end;
              });
        let events = 0;
        let tokens = 0;
        for (const node of slice) {
          events += 1;
          tokens += Number(node?.tokens ?? 0);
        }
        return { events, tokens };
      } catch {
        return null;
      }
    }

    /** 太窄就返回理由字符串，值得压就返回 null。 */
    skipReason(span) {
      if (!span) return null;
      if (span.events < this.limits.minCompactEvents) {
        return `events=${span.events} < ${this.limits.minCompactEvents}`;
      }
      if (span.tokens < this.limits.minCompactTokens) {
        return `tokens=${span.tokens} < ${this.limits.minCompactTokens}`;
      }
      return null;
    }

    /** 往 events.jsonl 追加一行器官事件（合体用）；写失败只记 trace，绝不影响压缩。 */
    emitEvent(event) {
      if (!this.events?.enabled) return null;
      // owner 统一在这里补：三个发射点不必各自记着（漏一个就少一份归属）
      const enriched = {
        ...event,
        payload: { ...(event?.payload ?? {}), owner: this.events.owner },
      };
      const written = appendEvent(this.events.stateRoot, enriched);
      if (!written) trace(`events: 写入失败（不影响压缩）type=${event?.type ?? '?'}`);
      else trace(`events: ${written.type} ${written.subject}`);
      return written;
    }

    async compactRegion(start, end, agent, signal) {
      const session = agent?.session;
      trace(`compactRegion enter: ${start}..${end} session=${session?.id ?? '?'}`);

      // 先量宽窄：太窄的段连归档都不做，等它变宽；太宽的先收窄（见 cutRange）
      let foldEnd = end;
      let span = session ? this.spanStats(session, start, end) : null;
      if (span && span.tokens > this.limits.maxFoldTokens) {
        const cut = this.cutRange(session, start, end, this.limits.maxFoldTokens);
        if (cut != null && cut !== end) {
          foldEnd = cut;
          trace(
            `compactRegion narrow: ${start}..${end} tokens=${span.tokens} > ${this.limits.maxFoldTokens} → ${start}..${cut}`
          );
          span = session ? this.spanStats(session, start, foldEnd) : span;
        }
      }
      trace(
        `compactRegion span: ${start}..${foldEnd} events=${span?.events ?? 'null'} tokens=${span?.tokens ?? 'null'}`
      );
      const skip = this.skipReason(span);
      if (skip) {
        this.blackhole.skipped += 1;
        this._skippedThisCall += 1;
        trace(
          `compactRegion skip: ${start}..${foldEnd} events=${span?.events ?? '?'} tokens=${span?.tokens ?? '?'} reason=${skip}`
        );
        this.emitEvent({
          type: EVENT_TYPE.SKIPPED,
          severity: 'info',
          subject: `窄段跳过 ${start}-${foldEnd}`,
          payload: {
            session: session?.id ?? null,
            start,
            end: foldEnd,
            events: span?.events ?? null,
            tokens: span?.tokens ?? null,
            reason: skip,
          },
        });
        return null;
      }

      let staged = null;

      if (session) {
        try {
          staged = stageRegion(this.archive, { session, start, end: foldEnd });
          // 这一段之前已经完整归档过（幂等复用）→ 不重复提交
          if (staged && staged.record.state === 'committed') staged = null;
          trace(`  staged: ${staged ? staged.record.key : 'none'}`);
        } catch (error) {
          this.ctx?.logger?.warn?.(`blackhole: 归档 staging 失败（不阻塞压缩）：${error?.message ?? error}`);
          trace(`  staging failed: ${error?.message ?? error}`);
          staged = null;
        }
      }

      // 原文已归档，下面这一刀只剪「给摘要器看的那一份」
      let faded = null;
      if (this.limits.fade && span && span.tokens >= this.limits.fadeMinSpanTokens) {
        const fadeStart = Date.now();
        faded = fadeRange({
          session,
          start,
          end: foldEnd,
          meter: this.ctx?.tokenMeter,
          config: this.limits.fadeConfig,
          trace,
        });
        if (faded.faded > 0) {
          trace(
            `  faded: events=${faded.faded} chars=${faded.charsBefore}→${faded.charsAfter} ms=${Date.now() - fadeStart}`
          );
          span = this.spanStats(session, start, foldEnd) ?? span;
        }
      }
      const foldStart = Date.now();

      try {
        const result = await super.compactRegion(start, foldEnd, agent, signal);
        if (staged) {
          const { committed, card } = commitRegion(this.archive, staged);
          appendCardIndex({ archiveRoot: this.archive.archiveRoot, card });
          this.blackhole.archived += 1;
          trace(`  committed+card: ${card?.title ?? '?'}`);
          this.emitEvent({
            type: EVENT_TYPE.ARCHIVED,
            severity: 'info',
            subject: `压缩归档 ${start}-${foldEnd}`,
            payload: {
              session: session?.id ?? null,
              start,
              end: foldEnd,
              events: staged.events?.length ?? null,
              cardId: card?.cardId ?? card?.id ?? null,
              title: card?.title ?? null,
              archive: committed?.finalPath ?? null,
            },
          });
        }
        this._lastFold = {
          ms: Date.now() - foldStart,
          tokens: span?.tokens ?? null,
          faded: faded?.faded ?? 0,
          charsSaved: faded ? faded.charsBefore - faded.charsAfter : 0,
        };
        this._foldedThisCall = true;
        this._foldSegmentsThisCall = (this._foldSegmentsThisCall ?? 0) + 1;
        trace(
          `compactRegion exit: ${start}..${foldEnd} OK archived=${this.blackhole.archived} foldMs=${this._lastFold.ms} tokens=${this._lastFold.tokens} faded=${this._lastFold.faded}`
        );
        return result;
      } catch (error) {
        const message = error?.message ?? String(error);
        const abandoned = staged ? this.archive.abandon(staged.record.key, message) : null;
        if (staged) this.blackhole.failed += 1;
        trace(`compactRegion exit: ${start}..${end} FAILED ${message}`);
        this.emitEvent({
          type: EVENT_TYPE.FAILED,
          severity: 'warn',
          subject: `压缩失败 ${start}-${end}`,
          payload: {
            session: session?.id ?? null,
            start,
            end,
            error: String(message).slice(0, 500),
            abandoned: Boolean(abandoned),
            archive: abandoned?.abandonedPath ?? null,
          },
        });
        throw error;
      }
    }

    /** 供状态查询：本期归档了多少段、失败多少段。 */
    stats() {
      return { ...this.blackhole, pending: this.archive.list().length };
    }
  };
}

/** 今日日期（给外部调用）。 */
export { today };
