import fs from 'node:fs';
import path from 'node:path';

/**
 * 器官事件（合体用）：按 handoff/规范/联动契约.md §2.2 往 events.jsonl 追加一行一条。
 *
 * 契约要点：
 * - 只追加、不回头改；书同文只读、记账，不删不改。
 * - 字段：ts / id / source / type / severity / subject / payload / trace。
 * - 路径由 organ.json 的 events.path 声明（当前 = <stateRoot>/events.jsonl），
 *   书同文按名片去读，所以两边路径必须一致。
 *
 * 事件类型（契约词表 + 本项目扩展）：
 * - compact.archived：压缩成功、原文已归档（severity=info）
 * - compact.skipped ：段太窄被跳过，等它变宽（info）
 * - archive.failed  ：压缩失败、原文按设计保留（warn）
 *
 * 失败绝不能影响压缩主流程：所有异常都在 appendEvent 里吞掉。
 */
export const EVENT_SOURCE = 'dsh-blackhole';

export const EVENT_TYPE = Object.freeze({
  ARCHIVED: 'compact.archived',
  SKIPPED: 'compact.skipped',
  FAILED: 'archive.failed',
  // 召回事件（2026-11-08 加，书同文评测用）：谁在什么时候从冷库取回了哪段、多大、digest 多少。
  RECALL_HIT: 'recall.hit',
});

/** <stateRoot>/events.jsonl（与 organ.json 的 events.path 对齐）。 */
export function eventsPath(stateRoot) {
  return path.join(stateRoot, 'events.jsonl');
}

/** 本地时间 + 时区偏移，形如 2026-11-05T04:10:00+08:00（契约示例就是这个格式）。 */
export function localIso(now = new Date()) {
  const pad = (n, width = 2) => String(Math.abs(n)).padStart(width, '0');
  const tz = -now.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const hh = pad(Math.floor(Math.abs(tz) / 60));
  const mm = pad(Math.abs(tz) % 60);
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${hh}:${mm}`
  );
}

let counter = 0;

function makeId(now) {
  counter = (counter + 1) % 1_000_000;
  return `evt-${EVENT_SOURCE}-${now.getTime().toString(36)}${counter.toString(36).padStart(4, '0')}`;
}

/**
 * 追加一条事件。返回值给测试断言用；写盘失败返回 null（调用方不需要关心）。
 */
export function appendEvent(
  stateRoot,
  { type, severity = 'info', subject = '', payload = null, trace = null, now = new Date() } = {}
) {
  if (!stateRoot || !type) return null;
  try {
    const file = eventsPath(stateRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const event = {
      // ts 按契约是本地时间带偏移（人读、机读都行）；tsMs 是同刻的 epoch 毫秒，
      // 给「按数值比较日期」的消费者用——账本 ledger.mjs 就是 Number.isFinite(e.ts) 过滤的，
      // 只有 ISO 字符串时会被整批丢掉（2026-11-07 实测：147 条 archived 被算成 0）。
      ts: localIso(now),
      tsMs: now.getTime(),
      id: makeId(now),
      source: EVENT_SOURCE,
      type: String(type),
      severity: String(severity),
      subject: String(subject),
      payload: payload ?? null,
      trace: trace ?? null,
    };
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  } catch {
    return null;
  }
}

/** 读回全部事件（只给测试和人工排查用；书同文直接读文件，不走这里）。 */
export function readEvents(stateRoot) {
  try {
    const text = fs.readFileSync(eventsPath(stateRoot), 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

