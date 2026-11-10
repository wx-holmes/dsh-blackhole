/**
 * 按天轮换事件视界（视界实验用）。
 *
 * 为什么放在插件里而不是每天手动改 cordis.patch.yml：
 * 白板那句「全时空靠黑洞插件钩子自动参与，不靠各时空自觉」就是为这个写的。
 * 手改配置要重启一次、还要有人记得；轮换写进这里，进程一启动就按当天日期算，
 * 各时空拿到的都是同一天的同一个档位。
 *
 * 配置形状（cordis.patch.yml 里 blackhole 的 config）：
 *   dailyHorizon:
 *     start: '2026-11-08'
 *     ratios: [0.7, 0.3, 0.5, 0.6]
 *
 * 语义：以 start 当天为第 0 天，按本地日期差取 ratios[(天数 mod 长度)]；
 * start 之前不生效（返回 null，用配置里的静态值）。ratios 里非数字/越界的项会被丢掉。
 *
 * 结果同时覆盖 thresholdRatio 与 eventHorizon：这两个是同一件事的两处记录
 * （父类用 thresholdRatio 判何时压，horizon 用来判这段该不该归档），只改一个会打架。
 */

const DAY_MS = 86400000;

/** 本地日期键 YYYY-MM-DD（按本地时区算，不用 UTC，避免半夜跨日对不上）。 */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function utcMidnight(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? ''));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 算出「今天该用哪一档」。
 * @returns {{ratio:number, dayIndex:number, day:string, start:string, plan:number[], clamped:boolean}|null}
 */
export function resolveDailyHorizon(config = {}, now = new Date(), { solidifyLine = 0.75 } = {}) {
  const plan = config?.dailyHorizon;
  if (!plan || !Array.isArray(plan.ratios) || plan.ratios.length === 0) return null;
  const start = plan.start;
  const startMs = utcMidnight(start);
  if (startMs == null) return null;

  const ratios = plan.ratios
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0.05 && v < 0.95);
  if (ratios.length === 0) return null;

  const day = localDateKey(now);
  const nowDayMs = utcMidnight(day);
  if (nowDayMs == null) return null;

  const days = Math.floor((nowDayMs - startMs) / DAY_MS);
  if (days < 0) return null;

  const dayIndex = ((days % ratios.length) + ratios.length) % ratios.length;
  const raw = ratios[dayIndex];
  // 视界不能越过固化线：越过时夹到固化线下方 0.01，并标记 clamped，
  // 免得 horizon.js 那句 `eventHorizon 必须小于 solidifyLine` 直接把插件挂掉。
  const ceiling = Number.isFinite(solidifyLine) ? solidifyLine - 0.01 : 0.94;
  const ratio = Math.min(raw, ceiling);
  return { ratio, dayIndex, day, start, plan: ratios, clamped: ratio !== raw };
}

/**
 * 跨零点就地刷新档位。
 *
 * 为什么需要：resolveDailyHorizon 只在 apply（插件加载）时算一次。
 * 2026-11-08 实测抓到的坑——当天 0.7 要等 01:17 那次重启才生效，
 * 00:00–01:17 的 16 行采样还是 0.28，等于实验第一天有 77 分钟跑的是前一天的档。
 * 这里每被调一次就按「现在」重算，变了就改 config 上的 thresholdRatio / eventHorizon。
 *
 * @returns {{changed:boolean, previous?:number, ratio?:number, info?:object}}
 */
export function refreshDailyHorizon(config = {}, now = new Date(), { solidifyLine = 0.75 } = {}) {
  const info = resolveDailyHorizon(config, now, { solidifyLine });
  if (!info) return { changed: false };
  const previous = Number(config.thresholdRatio);
  if (Number.isFinite(previous) && Math.abs(previous - info.ratio) < 1e-9
    && Math.abs(Number(config.eventHorizon) - info.ratio) < 1e-9) {
    return { changed: false, ratio: info.ratio, info };
  }
  config.thresholdRatio = info.ratio;
  config.eventHorizon = info.ratio;
  return { changed: Number.isFinite(previous) && Math.abs(previous - info.ratio) >= 1e-9, previous, ratio: info.ratio, info };
}
