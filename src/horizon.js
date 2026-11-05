/**
 * 事件视界：上下文占用水位与档位判定。
 *
 * 默认（可调）：
 *   event_horizon 0.60   到线 → 触发归档
 *   solidify_line 0.75   到线 → 热卡降冷、只留指针
 *   hard_cap      0.90   到线 → 不再加内容，只告警
 *
 * density = 发送给模型的 token / 可用窗口
 * 可用窗口 = 模型窗口 − 输出预留 − 安全余量
 */
export const HORIZON_DEFAULTS = Object.freeze({
  eventHorizon: 0.6,
  solidifyLine: 0.75,
  hardCap: 0.9,
});

/** 可用窗口（分母）。永远 > 0。 */
export function usableWindow(windowTokens, { outputReserve = 0, headroom = 0 } = {}) {
  return Math.max(1, windowTokens - outputReserve - headroom);
}

/** 信息密度（工程口径的占用率，不是「信息密度」指标本身）。 */
export function density(usedTokens, windowTokens, opts = {}) {
  return usedTokens / usableWindow(windowTokens, opts);
}

/** 档位：normal / archive / solidify / hardcap。 */
export function level(currentDensity, config = HORIZON_DEFAULTS) {
  if (currentDensity >= config.hardCap) return 'hardcap';
  if (currentDensity >= config.solidifyLine) return 'solidify';
  if (currentDensity >= config.eventHorizon) return 'archive';
  return 'normal';
}

/** 是否该触发归档。 */
export function shouldArchive(currentDensity, config = HORIZON_DEFAULTS) {
  return level(currentDensity, config) !== 'normal';
}

/** 回溯缓冲区预算：水位 ≥ 0.70 时降为 0，只留指针。 */
export function recallBufferBudget(base, currentDensity) {
  return currentDensity >= 0.7 ? 0 : base;
}

/**
 * 校验配置（加载时快速失败）。
 * @returns 规范化后的配置
 */
export function resolveHorizon(config = {}) {
  const merged = { ...HORIZON_DEFAULTS };
  for (const key of Object.keys(config)) {
    if (key in HORIZON_DEFAULTS) merged[key] = Number(config[key]);
  }
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`horizon: ${name} 必须在 (0, 1] 之间，收到 ${value}`);
    }
  }
  if (merged.eventHorizon >= merged.solidifyLine) throw new Error('horizon: eventHorizon 必须小于 solidifyLine');
  if (merged.solidifyLine >= merged.hardCap) throw new Error('horizon: solidifyLine 必须小于 hardCap');
  return merged;
}
