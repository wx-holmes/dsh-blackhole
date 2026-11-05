import fs from 'node:fs';
import path from 'node:path';
import { contentHash, rangeHash, idempotencyKey } from './hash.js';
import {
  defaultArchiveRoot,
  defaultStateRoot,
  archivePathWithOrdinal,
  pendingPath,
} from './paths.js';

export const ARCHIVE_STATE = Object.freeze({
  STAGING: 'staging',
  PENDING: 'pending',
  COMMITTED: 'committed',
  ABANDONED: 'abandoned',
});

/**
 * 两阶段归档。
 *
 * 生命周期：staging → pending → committed / abandoned。
 * - staging：原文逐字落盘到临时文件，不推进水印。
 * - pending：记录已就绪、等待提交（替换成功后才能提交）。
 * - committed：替换落地，写正式文件、删临时文件与 pending 记录。
 * - abandoned：放弃本次，原文保留（改名 .abandoned），不删任何东西。
 *
 * 幂等键 = 区间 hash + 内容 hash + 调用幂等键；重复 stage 直接复用。
 */
export class ArchiveStore {
  constructor({ archiveRoot, stateRoot, now = () => new Date(), pendingTtlMs = 10 * 60 * 1000 } = {}) {
    this.archiveRoot = archiveRoot ?? defaultArchiveRoot();
    this.stateRoot = stateRoot ?? defaultStateRoot();
    this.now = now;
    this.pendingTtlMs = pendingTtlMs;
  }

  /** 1) staging：计算哈希、写临时原文。 */
  stage({ sid, date, start, end, events, callId }) {
    if (!Array.isArray(events) || events.length === 0) throw new Error('archive.stage: events 不能为空');
    const cHash = contentHash(events);
    const rHash = rangeHash(start, end);
    const key = idempotencyKey({ sid, start, end, cHash, callId });

    const existing = this.readPending(key);
    if (existing) return { ...existing, reused: true };

    // 已提交过的同一事务（重放）→ 直接复用，不重复写盘
    const done = this.readCommitted(key);
    if (done) return { ...done, reused: true };

    let ordinal = 0;
    let finalPath;
    for (;;) {
      finalPath = archivePathWithOrdinal({ root: this.archiveRoot, sid, date, start, end, ordinal });
      if (!fs.existsSync(finalPath) && !fs.existsSync(`${finalPath}.failed`)) break;
      ordinal += 1;
      if (ordinal > 999) throw new Error('archive.stage: 同一区间冲突过多，停止');
    }

    const stagingPath = `${finalPath}.${key.slice(0, 8)}.staging`;
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(stagingPath, renderArchive({ sid, date, start, end, events, cHash, rHash, key, now: this.now }), 'utf8');

    const record = {
      key,
      sid,
      date,
      start,
      end,
      contentHash: cHash,
      rangeHash: rHash,
      stagingPath,
      finalPath,
      state: ARCHIVE_STATE.STAGING,
      createdAt: this.now().toISOString(),
    };
    this.writePending(record);
    return record;
  }

  /** 2) pending：标记已就绪，等待替换结果。 */
  markPending(key) {
    const record = this.requirePending(key);
    record.state = ARCHIVE_STATE.PENDING;
    record.pendingAt = this.now().toISOString();
    this.writePending(record);
    return record;
  }

  /** 3) committed：替换成功后提交。写正式文件，清理临时文件，留一条提交索引用于幂等。 */
  commit(key) {
    const record = this.requirePending(key);
    const body = fs.readFileSync(record.stagingPath, 'utf8');
    fs.writeFileSync(record.finalPath, body.replace(/^state: .*$/m, `state: ${ARCHIVE_STATE.COMMITTED}`), 'utf8');
    fs.rmSync(record.stagingPath, { force: true });
    fs.rmSync(pendingPath({ stateRoot: this.stateRoot, key }), { force: true });
    const committed = { ...record, state: ARCHIVE_STATE.COMMITTED, committedAt: this.now().toISOString() };
    this.writeJournal(ARCHIVE_STATE.COMMITTED, committed);
    return committed;
  }

  /**
   * 4) abandoned：放弃本次。
   * 原文不删，就地改名成 `<finalPath>.abandoned`——原文仍留在它本来该归档的位置，
   * 只是挂上 .abandoned 后缀；正式归档是 .md，所以半成品不会冒充成品被读走。
   * 该位置已被占（同一段重复放弃）时退到 `<finalPath>.<key8>.abandoned`，绝不覆盖已有原文。
   */
  abandon(key, reason = 'abandoned') {
    const record = this.readPending(key);
    if (!record) return null;
    let trashPath = null;
    if (fs.existsSync(record.stagingPath)) {
      trashPath = `${record.finalPath}.abandoned`;
      if (fs.existsSync(trashPath)) {
        trashPath = `${record.finalPath}.${key.slice(0, 8)}.abandoned`;
      }
      fs.mkdirSync(path.dirname(trashPath), { recursive: true });
      fs.renameSync(record.stagingPath, trashPath);
    }
    fs.rmSync(pendingPath({ stateRoot: this.stateRoot, key }), { force: true });
    const abandoned = {
      ...record,
      state: ARCHIVE_STATE.ABANDONED,
      abandonedAt: this.now().toISOString(),
      reason,
      abandonedPath: trashPath,
    };
    this.writeJournal(ARCHIVE_STATE.ABANDONED, abandoned);
    return abandoned;
  }

  /** 崩溃恢复：超时的 pending 一律 abandoned（原文保留）；已提交的补提交不重复。 */
  recover() {
    const out = { committed: 0, abandoned: 0 };
    for (const record of this.list()) {
      if (fs.existsSync(record.finalPath) && !fs.existsSync(record.stagingPath)) {
        out.committed += 1;
        fs.rmSync(pendingPath({ stateRoot: this.stateRoot, key: record.key }), { force: true });
        continue;
      }
      const age = this.now().getTime() - new Date(record.createdAt).getTime();
      if (age > this.pendingTtlMs) {
        this.abandon(record.key, 'timeout');
        out.abandoned += 1;
      }
    }
    return out;
  }

  readPending(key) {
    const p = pendingPath({ stateRoot: this.stateRoot, key });
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  /** 已提交索引（很小，保留用于幂等重放与审计）。 */
  readCommitted(key) {
    const p = path.join(this.stateRoot, ARCHIVE_STATE.COMMITTED, `${key}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  /** 状态流水：committed / abandoned 各留一份。 */
  writeJournal(status, record) {
    const p = path.join(this.stateRoot, status, `${record.key}.json`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(record, null, 2), 'utf8');
  }

  requirePending(key) {
    const record = this.readPending(key);
    if (!record) throw new Error(`archive: 找不到 pending 记录 ${key}`);
    return record;
  }

  list() {
    const dir = path.join(this.stateRoot, 'pending');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  }

  writePending(record) {
    const p = pendingPath({ stateRoot: this.stateRoot, key: record.key });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(record, null, 2), 'utf8');
  }
}

/** 渲染归档正文：元数据头 + 事件逐字。 */
export function renderArchive({ sid, date, start, end, events, cHash, rHash, key, now }) {
  const head = [
    '---',
    `sid: ${sid}`,
    `date: ${date}`,
    `range: ${start}-${end}`,
    `events: ${events.length}`,
    `state: ${ARCHIVE_STATE.STAGING}`,
    `createdAt: ${now().toISOString()}`,
    `contentHash: ${cHash}`,
    `rangeHash: ${rHash}`,
    `idempotencyKey: ${key}`,
    '---',
    '',
    `# 黑洞归档 · 区间 ${start}-${end}（${events.length} 条）`,
    '',
  ].join('\n');

  const body = events.map((event) => `## [${event.seq}] ${event.type}\n\n${renderEventBody(event)}\n`).join('\n');
  return head + body;
}

/** 逐字渲染一条事件：优先抽文本，抽不到就把 data 完整序列化。 */
export function renderEventBody(event) {
  const data = event?.data;
  const text = extractText(data);
  if (text && text.trim().length > 0) return text;
  return '```json\n' + JSON.stringify(data ?? null, null, 2) + '\n```';
}

function extractText(data) {
  const message = data?.message ?? data;
  if (!message || typeof message !== 'object') return '';
  if (typeof message === 'string') return message;
  const blocks = message.content;
  if (!Array.isArray(blocks)) {
    if (typeof data?.text === 'string') return data.text;
    return '';
  }
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool-call') parts.push(`[tool-call ${block.name ?? ''}] ${JSON.stringify(block.arguments ?? block.input ?? null)}`);
    else if (block.type === 'tool-result') parts.push(`[tool-result] ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? null)}`);
    else parts.push(`[${block.type}] ${JSON.stringify(block)}`);
  }
  return parts.join('\n');
}
