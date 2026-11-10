/**
 * 跨零点换档：apply 只算一次，00:00 之后要自己变（2026-11-08 实测坑）。
 */
import { refreshDailyHorizon } from '../src/rotation.js';

const checks = [];
const ok = (name, cond, extra = '') => checks.push({ name, pass: Boolean(cond), extra });
const at = (iso) => new Date(`${iso}T12:00:00+08:00`);
const plan = { start: '2026-11-08', ratios: [0.7, 0.3, 0.5, 0.6] };

const cfg = { dailyHorizon: plan, thresholdRatio: 0.28, eventHorizon: 0.28 };
const r1 = refreshDailyHorizon(cfg, at('2026-11-08'));
ok('0.28 → 0.7，两处一起改', r1.changed === true && cfg.thresholdRatio === 0.7 && cfg.eventHorizon === 0.7, JSON.stringify(r1));

const r2 = refreshDailyHorizon(cfg, at('2026-11-08'));
ok('同一天再跑不算变化', r2.changed === false);

const r3 = refreshDailyHorizon(cfg, at('2026-11-09'));
ok('第二天自动换 0.3', r3.changed === true && cfg.thresholdRatio === 0.3 && r3.previous === 0.7, JSON.stringify({ prev: r3.previous, now: cfg.thresholdRatio }));

const before = refreshDailyHorizon({ dailyHorizon: plan, thresholdRatio: 0.4, eventHorizon: 0.4 }, at('2026-11-07'));
ok('start 之前不动', before.changed === false);

const noPlan = { thresholdRatio: 0.45, eventHorizon: 0.45 };
const r4 = refreshDailyHorizon(noPlan, at('2026-11-10'));
ok('没配 dailyHorizon 时什么都不做', r4.changed === false && noPlan.thresholdRatio === 0.45);

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  ' + c.extra}`);
console.log(`rotation-refresh: ${checks.length - failed.length}/${checks.length} pass`);
process.exit(failed.length === 0 ? 0 : 1);
