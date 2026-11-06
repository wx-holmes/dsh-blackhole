/**
 * 先剪后折（2026-11-07）。
 *
 * 为什么要这层：折叠的耗时几乎全在 prefill——摘要器要把这一段的 token 全读一遍。
 * 而长会话里大头是老工具输出（一次 PowerShell 几百 KB 的 JSON）。把这些中段剪掉：
 *   - 不花模型，毫秒级；
 *   - 摘要要读的 token 立刻少三到五成；
 *   - 段变小后，一次能折更多历史，折叠次数跟着下降。
 *
 * 与官方 tool-result-pruner 的关系：口径照抄（头 + 标记 + 尾，按码点切，不拆代理对），
 * 但作用范围不同——pruner 是整场扫，我们只在「已经确定要折的那一段」里剪，
 * 而且是**归档之后**才剪：原文已经进黑洞仓，剪掉的只是给摘要器看的那一份。
 */

/** 固定在两截之间插入的标记（与官方 pruner 的措辞刻意区分，便于日志辨认）。 */
export const FADE_MARKER = '\n\n[... 工具输出中段已剪，原文在黑洞归档里 ...]\n\n';

const DEFAULTS = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };

/** 解析并校验剪裁预算；坏配置只降级为「不剪」，不抛。 */
export function resolveFadeConfig(options = {}) {
  const pick = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
  };
  const thresholdChars = pick(options.fadeMinChars, DEFAULTS.thresholdChars);
  const headChars = pick(options.fadeHeadChars, DEFAULTS.headChars);
  const tailChars = pick(options.fadeTailChars, DEFAULTS.tailChars);
  if (headChars + tailChars >= thresholdChars) {
    return { thresholdChars: DEFAULTS.thresholdChars, headChars: DEFAULTS.headChars, tailChars: DEFAULTS.tailChars };
  }
  return { thresholdChars, headChars, tailChars };
}

/** 数码点（不拆代理对）。 */
export function codePointLength(text) {
  return Array.from(String(text ?? '')).length;
}

function measureContent(blocks) {
  let chars = 0;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text') chars += codePointLength(block.text);
  }
  return chars;
}

/**
 * 把一段内容里过大的文本中段换成标记，保留其余块与非文本块的顺序。
 * 返回新内容；未超预算返回 null。
 */
export function fadeContent(blocks, config) {
  const totalChars = measureContent(blocks);
  if (totalChars <= config.thresholdChars) return null;
  const removedStart = config.headChars;
  const removedEnd = totalChars - config.tailChars;
  const out = [];
  let consumed = 0;
  let markerInserted = false;
  for (const block of blocks) {
    if (block?.type !== 'text') {
      out.push(block);
      continue;
    }
    const points = Array.from(block.text ?? '');
    const blockStart = consumed;
    const blockEnd = blockStart + points.length;
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
    const marker =
      blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? FADE_MARKER : '';
    if (marker.length > 0) markerInserted = true;
    const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('');
    if (text.length > 0) out.push({ ...block, text });
    consumed = blockEnd;
  }
  if (!markerInserted) return null;
  return out;
}

/**
 * 在一段 surface 区间里剪工具输出。
 *
 * @returns {{faded:number, charsBefore:number, charsAfter:number, seqs:number[]}}
 *   失败一律当成「没剪」，绝不影响外层压缩。
 */
export function fadeRange({ session, start, end, meter, config, trace = () => {} }) {
  const result = { faded: 0, charsBefore: 0, charsAfter: 0, seqs: [] };
  try {
    const nodes = session?.surface?.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) return result;
    const startIdx = nodes.findIndex((seq) => Number(seq) === Number(start));
    const endIdx = nodes.findIndex((seq) => Number(seq) === Number(end));
    if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) return result;
    const targets = nodes.slice(startIdx, endIdx + 1).map(Number);
    for (const seq of targets) {
      let event;
      try {
        event = session.eventAt(seq);
      } catch {
        continue;
      }
      if (event?.type !== 'tool/result') continue;
      let original;
      try {
        original = session.deriveEventMessage(event);
      } catch {
        continue;
      }
      const content = fadeContent(original?.content ?? [], config);
      if (content === null) continue;
      const before = measureContent(original.content);
      const after = measureContent(content);
      let shadowTokens = 0;
      try {
        shadowTokens = Number(meter?.estimateMessage?.(original) ?? 0);
      } catch {
        shadowTokens = 0;
      }
      try {
        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: shadowTokens,
        });
        session.append(
          'tool/result',
          { ...event.data, message: { ...original, content } },
          {
            surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
            sourceEventSeqs: [seq],
          }
        );
      } catch (error) {
        trace(`  fade skip ${seq}: ${error?.message ?? error}`);
        continue;
      }
      result.faded += 1;
      result.charsBefore += before;
      result.charsAfter += after;
      result.seqs.push(seq);
    }
  } catch (error) {
    trace(`  fade failed: ${error?.message ?? error}`);
  }
  return result;
}
