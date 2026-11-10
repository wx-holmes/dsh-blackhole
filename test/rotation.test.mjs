/**
 * 日轮换测试（视界实验）：日期 → 档位 的映射必须可预测，否则实验数据没法比。
 * 全部用固定日期，不读系统时钟。
 */
import { resolveDailyHorizon, localDateKey } from '../src/rotation.js';

const checks = [];
const ok = (name, cond, extra = '') => checks.push({ name, pass: Boolean(cond), extra });
const at = (iso) => new Date(`${iso}T12:00:00+08:00`);
const plan = { start: '2026-11-08', ratios: [0.7, 0.3, 0.5, 0.6] };

ok('没有配置 → null', resolveDailyHorizon({}, at('2026-11-08')) === null);
ok('局部日期键', localDateKey(at('2026-11-08')) === '2026-11-08', localDateKey(at('2026-11-08')));

ok('start 之前不生效', resolveDailyHorizon({ dailyHorizon: plan }, at('2026-11-07')) === null);
ok('start 当天是第 0 档 0.7', resolveDailyHorizon({ dailyHorizon: plan }, at('2026-11-08'))?.ratio === 0.7);
ok('第 1 天 0.3', resolveDailyHorizon({ dailyHorizon: plan }, at('2026-11-09'))?.ratio === 0.3);
ok('第 2 天 0.5', resolveDailyHorizon({ dailyHorizon: plan }, at('2026-11-10'))?.ratio === 0.5);
ok('第 3 天 0.6', resolveDailyHorizon({ dailyHorizon: plan }, at('2026-11-11'))?.ratio === 0.6);
ok('第 4 天绕回 0.7', resolveDailyHorizon({ dailyHorizon: plan }, at('2026-11-12'))?.ratio === 0.7, JSON.stringify(resolveDailyHorizon({ dailyHorizon: plan }, at('2026-11-12'))));
ok('dayIndex 循环', resolveDailyHorizon({ dailyHorizon: plan }, at('2026-11-12'))?.dayIndex === 0);

const messy = { start: '2026-11-08', ratios: ['x', 0.5, 2, -1, null] };
ok('非法档位被丢掉，只剩 0.5', resolveDailyHorizon({ dailyHorizon: messy }, at('2026-11-08'))?.ratio === 0.5, JSON.stringify(resolveDailyHorizon({ dailyHorizon: messy }, at('2026-11-08'))));
ok('全是非法值 → null', resolveDailyHorizon({ dailyHorizon: { start: '2026-11-08', ratios: ['x', -1] } }, at('2026-11-08')) === null);

const tooHigh = { start: '2026-11-08', ratios: [0.9] };
const clamped = resolveDailyHorizon({ dailyHorizon: tooHigh }, at('2026-11-08'), { solidifyLine: 0.75 });
ok('越过固化线被夹到 0.74', clamped?.ratio === 0.74 && clamped.clamped === true, JSON.stringify(clamped));

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  ' + c.extra}`);
console.log(`rotation: ${checks.length - failed.length}/${checks.length} pass`);
process.exit(failed.length === 0 ? 0 : 1);

