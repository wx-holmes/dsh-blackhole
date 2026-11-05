import { buildCard } from './cards.js';

/**
 * 取某个区间的事件（数据源 = session 事件，不是 input.messages）。
 * surface.nodes 是当前 surface 的 seq 列表；eventAt 取原始事件。
 */
export function collectRegionEvents(session, start, end) {
  const nodes = session?.surface?.nodes ?? [];
  const from = Number(start);
  const to = Number(end);
  return nodes
    .filter((seq) => Number(seq) >= from && Number(seq) <= to)
    .map((seq) => session.eventAt(seq))
    .filter((event) => event !== undefined && event !== null);
}

/** 本地日期字符串（按运行机器时区）。 */
export function today(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 归档 + 卡的最小组合：stage 后立即 markPending，返回待提交上下文。 */
export function stageRegion(store, { session, start, end, callId, now }) {
  const date = today(now?.() ?? new Date());
  const events = collectRegionEvents(session, start, end);
  if (!events.length) return null;
  const record = store.stage({
    sid: session.id,
    date,
    start: Number(start),
    end: Number(end),
    events,
    callId,
  });
  // 只有全新 staging 才转 pending；复用的已提交记录不重复登记
  if (record.state === 'staging') store.markPending(record.key);
  return { record, events, date };
}

/** 提交：写正式文件 + 追加索引卡。 */
export function commitRegion(store, staged) {
  const committed = store.commit(staged.record.key);
  const card = buildCard({
    sid: staged.record.sid,
    date: staged.date,
    events: staged.events,
    archivePath: committed.finalPath,
  });
  return { committed, card };
}
