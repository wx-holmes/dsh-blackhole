import os from 'node:os';
import path from 'node:path';

/** 原文真源：书同文 self 档。 */
export function defaultArchiveRoot() {
  return process.env.BLACKHOLE_ARCHIVE_ROOT || path.join(os.homedir(), '.dsh', 'blackhole', 'archive');
}

/** 插件自己的状态/缓存区（可重建）。 */
export function defaultStateRoot() {
  return process.env.BLACKHOLE_STATE_ROOT || path.join(os.homedir(), '.dsh', 'blackhole', 'state');
}

/** 原文文件路径：<root>/<sid>/<date>/<seq起>-<seq止>.md */
export function archivePath({ root, sid, date, start, end }) {
  return path.join(root, sanitize(sid), sanitize(date), `${start}-${end}.md`);
}

/** pending 记录：<state>/pending/<key>.json */
export function pendingPath({ stateRoot, key }) {
  return path.join(stateRoot, 'pending', `${key}.json`);
}

/** 同一范围、不同内容时，用序号区分，避免互相覆盖。 */
export function archivePathWithOrdinal({ root, sid, date, start, end, ordinal }) {
  const base = archivePath({ root, sid, date, start, end });
  if (ordinal === 0) return base;
  return base.replace(/\.md$/, `-${ordinal}.md`);
}

function sanitize(part) {
  return String(part).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}
