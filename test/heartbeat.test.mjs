/**
 * 心跳测试：书同文契约 §四要求「心」是定时无条件重写的文件。
 * 这里验三件：写得出、字段齐、停得掉（停止后不再更新）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHeartbeat } from '../src/heartbeat.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-hb-'));
const checks = [];
const ok = (name, cond, extra = '') => checks.push({ name, pass: Boolean(cond), extra });

try {
  const beat = startHeartbeat({ stateRoot: dir, intervalMs: 50 });
  ok('心跳文件落在 state/heartbeat.json', beat.file === path.join(dir, 'state', 'heartbeat.json'), beat.file);
  ok('启动即写（不用等第一个周期）', fs.existsSync(beat.file));

  const first = JSON.parse(fs.readFileSync(beat.file, 'utf8'));
  ok('字段齐：ts / tsMs / pid / plugin', first.ts && first.tsMs && first.pid && first.plugin === 'dsh-blackhole', JSON.stringify(first));
  ok('tsMs 与 ts 对得上', Math.abs(Date.parse(first.ts) - first.tsMs) < 2000);

  const before = first.tsMs;
  await new Promise((r) => setTimeout(r, 400)); // 必须让出事件循环，忙等会让定时器根本没机会跑
  const second = JSON.parse(fs.readFileSync(beat.file, 'utf8'));
  ok('周期内被重写（mtime 前进）', second.tsMs > before, `${before} → ${second.tsMs}`);

  beat.stop();
  const afterStop = JSON.parse(fs.readFileSync(beat.file, 'utf8')).tsMs;
  await new Promise((r) => setTimeout(r, 300));
  const final = JSON.parse(fs.readFileSync(beat.file, 'utf8')).tsMs;
  ok('stop() 之后不再写', final === afterStop, `${afterStop} → ${final}`);

  let threw = false;
  try { startHeartbeat({}); } catch { threw = true; }
  ok('缺 stateRoot 直接报错（不静默）', threw);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  ' + c.extra}`);
console.log(`heartbeat: ${checks.length - failed.length}/${checks.length} pass`);
process.exit(failed.length === 0 ? 0 : 1);
