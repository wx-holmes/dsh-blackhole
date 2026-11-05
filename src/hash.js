import { createHash } from 'node:crypto';

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 区间哈希：只标识「哪一段」。 */
export function rangeHash(start, end) {
  return sha256(`${start}-${end}`);
}

/**
 * 内容哈希：把事件序列化成稳定字符串再哈希。
 * 只取 seq / type / data，避免把时间戳、来源等易变字段算进去。
 */
export function contentHash(events) {
  const canon = events
    .map((e) => `${e.seq}\u0001${e.type}\u0001${stableStringify(e.data ?? null)}`)
    .join('\u0002');
  return sha256(canon);
}

/** 幂等键 = 区间 hash + 内容 hash + 调用幂等键（compactionId 或显式 callId）。 */
export function idempotencyKey({ sid, start, end, cHash, callId }) {
  return sha256([sid, start, end, rangeHash(start, end), cHash, callId ?? ''].join('|'));
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
