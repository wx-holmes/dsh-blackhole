import { appendFileSync } from 'node:fs';
import { ArchiveStore } from './archive.js';
import { appendCardIndex } from './cards.js';
import { appendEvent, EVENT_TYPE } from './events.js';
import { commitRegion, stageRegion, today } from './region.js';

/** 排查用：插件在 DSH 进程里看不到 stdout（看门狗 stdio:'ignore'），只能自己落文件。 */
const TRACE_FILE = 'A:\\dsh-plugins\\dsh-blackhole\\trace.log';

export function trace(line) {
  try {
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8');
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
      };
      this._skippedThisCall = 0;
      // 合体：往 <stateRoot>/events.jsonl 写器官事件，供书同文读进账本（联动契约 §2.2）。
      // 路径必须与 organ.json 的 events.path 一致；写失败只记 trace，绝不影响压缩。
      this.events = { stateRoot: this.archive.stateRoot, enabled: options.events !== false };
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
      this._skippedThisCall = 0;
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

        // 2) 当前估算占用
        try {
          const meter = this.ctx?.tokenMeter;
          const measurement = meter?.measure?.(session);
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

      try {
        const result = await super.compactIfNeeded(agent, trigger, signal);
        trace(
          `ifNeeded exit: trigger=${trigger} result=${result ? 'COMPACTED' : 'null'} ms=${Date.now() - startedAt}`
        );
        return result;
      } catch (error) {
        const message = error?.message ?? String(error);
        // 父类重试用尽后会抛「还是压不下去」。如果这一轮被我们跳过的全是窄段，
        // 那这次的“压不下去”是主动选择（等段变宽），不是故障，不该往上冒。
        if (this._skippedThisCall > 0 && /still above threshold/i.test(message)) {
          trace(
            `ifNeeded: ${this._skippedThisCall} 次窄段跳过，父类报阈值未降，按「等段变宽」处理：${message}`
          );
          return null;
        }
        trace(
          `ifNeeded threw: trigger=${trigger} name=${error?.name} msg=${message} ms=${Date.now() - startedAt}`
        );
        throw error;
      }
    }

    /**
     * 量一段区间的宽窄：事件数 + token 数（口径与父类一致，都用 tokenMeter 的 pricing）。
     * 拿不到 measurement 就返回 null，表示「不知道，别拦」。
     */
    spanStats(session, start, end) {
      try {
        const nodes = this.ctx?.tokenMeter?.measure?.(session)?.nodes;
        if (!Array.isArray(nodes) || nodes.length === 0) return null;
        let events = 0;
        let tokens = 0;
        for (const node of nodes) {
          const seq = node?.seq;
          if (!Number.isFinite(seq) || seq < start || seq > end) continue;
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
      const written = appendEvent(this.events.stateRoot, event);
      if (!written) trace(`events: 写入失败（不影响压缩）type=${event?.type ?? '?'}`);
      else trace(`events: ${written.type} ${written.subject}`);
      return written;
    }

    async compactRegion(start, end, agent, signal) {
      const session = agent?.session;
      trace(`compactRegion enter: ${start}..${end} session=${session?.id ?? '?'}`);

      // 先量宽窄：太窄的段连归档都不做，等它变宽
      const span = session ? this.spanStats(session, start, end) : null;
      const skip = this.skipReason(span);
      if (skip) {
        this.blackhole.skipped += 1;
        this._skippedThisCall += 1;
        trace(
          `compactRegion skip: ${start}..${end} events=${span?.events ?? '?'} tokens=${span?.tokens ?? '?'} reason=${skip}`
        );
        this.emitEvent({
          type: EVENT_TYPE.SKIPPED,
          severity: 'info',
          subject: `窄段跳过 ${start}-${end}`,
          payload: {
            session: session?.id ?? null,
            start,
            end,
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
          staged = stageRegion(this.archive, { session, start, end });
          // 这一段之前已经完整归档过（幂等复用）→ 不重复提交
          if (staged && staged.record.state === 'committed') staged = null;
          trace(`  staged: ${staged ? staged.record.key : 'none'}`);
        } catch (error) {
          this.ctx?.logger?.warn?.(`blackhole: 归档 staging 失败（不阻塞压缩）：${error?.message ?? error}`);
          trace(`  staging failed: ${error?.message ?? error}`);
          staged = null;
        }
      }

      try {
        const result = await super.compactRegion(start, end, agent, signal);
        if (staged) {
          const { committed, card } = commitRegion(this.archive, staged);
          appendCardIndex({ archiveRoot: this.archive.archiveRoot, card });
          this.blackhole.archived += 1;
          trace(`  committed+card: ${card?.title ?? '?'}`);
          this.emitEvent({
            type: EVENT_TYPE.ARCHIVED,
            severity: 'info',
            subject: `压缩归档 ${start}-${end}`,
            payload: {
              session: session?.id ?? null,
              start,
              end,
              events: staged.events?.length ?? null,
              cardId: card?.cardId ?? card?.id ?? null,
              title: card?.title ?? null,
              archive: committed?.finalPath ?? null,
            },
          });
        }
        trace(`compactRegion exit: ${start}..${end} OK archived=${this.blackhole.archived}`);
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
