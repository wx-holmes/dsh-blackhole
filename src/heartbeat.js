/**
 * 心跳：给「心」插头一个无条件重写的文件。
 *
 * 为什么不能拿 trace.log 当心跳（2026-11-07 书同文契约 §四）：
 * trace.log 只在压缩活动时才写。夜里所有时空都闲着的时候，它十几分钟不动一次，
 * 书同文按 ttl 判下来就是「半死」——但黑洞其实活得好好的。心跳必须是定时无条件重写，
 * 跟有没有活干无关。
 *
 * 文件写在 stateRoot/state/heartbeat.json；organ.json 的 health.path 指向它。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_HEARTBEAT_MS = 60_000;

/**
 * 起一个心跳定时器。
 * @returns {{file:string, write:()=>object, stop:()=>void}}
 */
export function startHeartbeat({ stateRoot, intervalMs = DEFAULT_HEARTBEAT_MS } = {}) {
  if (!stateRoot) throw new Error('heartbeat: 缺 stateRoot');
  const file = path.join(stateRoot, 'state', 'heartbeat.json');

  const write = () => {
    const now = new Date();
    const beat = {
      ts: now.toISOString(),
      tsMs: now.getTime(),
      pid: process.pid,
      plugin: 'dsh-blackhole',
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(beat)}\n`, 'utf8');
    return beat;
  };

  write();
  const timer = setInterval(() => {
    try {
      write();
    } catch {
      // 心跳写不进去也不能把压缩链路带崩：下一轮再试。
    }
  }, intervalMs);
  timer.unref?.();

  return { file, write, stop: () => clearInterval(timer) };
}
