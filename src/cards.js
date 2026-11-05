import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './hash.js';

/**
 * 索引卡：原文的检索入口，不承担回答职责。
 * 字段见施工图 §7 index_card。
 */
export function buildCard({ sid, date, events, archivePath, now = () => new Date() }) {
  if (!events.length) throw new Error('buildCard: events 不能为空');
  const first = events[0];
  const last = events[events.length - 1];
  const text = collectText(events);
  const cardId = `bh_${date.replace(/-/g, '')}_${sha256(`${sid}|${first.seq}|${last.seq}|${text.slice(0, 64)}`).slice(0, 8)}`;
  return {
    cardId,
    sid,
    title: deriveTitle(events, first, last),
    date,
    range: [first.seq, last.seq],
    events: events.length,
    summary: deriveSummary(events),
    src: archivePath,
    tags: deriveTags(events),
    heat: 0,
    tier: 'hot',
    supersededBy: null,
    createdAt: now().toISOString(),
  };
}

/** 标题：优先第一条用户消息，其次助手消息，再次区间描述。 */
export function deriveTitle(events, first = events[0], last = events[events.length - 1]) {
  for (const wanted of ['user/message', 'assistant/message']) {
    for (const event of events) {
      if (event.type !== wanted) continue;
      const text = extractText(event.data);
      if (text && text.trim().length > 0) {
        const flat = text.replace(/\s+/g, ' ').trim();
        return flat.length > 36 ? `${flat.slice(0, 36)}…` : flat;
      }
    }
  }
  return `${first.type} 区间 ${first.seq}-${last.seq}`;
}

/** 规则摘要（不调用模型）：首条用户句 + 末条助手句 + 工具调用清单。 */
export function deriveSummary(events) {
  const parts = [];
  const firstUser = events.find((e) => e.type === 'user/message');
  const lastAssistant = [...events].reverse().find((e) => e.type === 'assistant/message');
  if (firstUser) {
    const t = shorten(extractText(firstUser.data), 60);
    if (t) parts.push(`起点：${t}`);
  }
  if (lastAssistant) {
    const t = shorten(extractText(lastAssistant.data), 60);
    if (t) parts.push(`收尾：${t}`);
  }
  const tools = events.filter((e) => e.type === 'assistant/message').flatMap((e) => toolNames(e.data));
  if (tools.length) parts.push(`工具：${[...new Set(tools)].join(', ')}`);
  if (!parts.length) parts.push(`${events.length} 条事件，无文本可摘`);
  return parts.join('；');
}

/** 标签：文件路径 + 工具名。 */
export function deriveTags(events) {
  const text = collectText(events);
  const files = [...new Set(text.match(/[A-Za-z]:(?:\\|\/)[^\s"'`，。；：、）)】\]]{2,80}/g) ?? [])];
  const names = [...new Set(events.filter((e) => e.type === 'assistant/message').flatMap((e) => toolNames(e.data)))];
  return [...names, ...files.slice(0, 6)].slice(0, 10);
}

export function collectText(events) {
  return events.map((e) => extractText(e.data)).filter(Boolean).join('\n');
}

/**
 * 追加索引卡：
 * - <archiveRoot>/index.jsonl   机读（一行一卡）
 * - <archiveRoot>/索引.md       人读（书同文扫这一页）
 */
export function appendCardIndex({ archiveRoot, card }) {
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.appendFileSync(path.join(archiveRoot, 'index.jsonl'), `${JSON.stringify(card)}\n`, 'utf8');

  const md = path.join(archiveRoot, '索引.md');
  if (!fs.existsSync(md)) {
    fs.writeFileSync(
      md,
      ['# 上下文索引', '', '> 每行一段被归纳的对话；原文在 src 列，用 recall 取回。', '', '| 日期 | 标题 | 区间 | 原文 |', '|---|---|---|---|', ''].join('\n'),
      'utf8'
    );
  }
  const safeTitle = String(card.title).replace(/\|/g, '\\|');
  fs.appendFileSync(md, `| ${card.date} | ${safeTitle} | ${card.range[0]}-${card.range[1]} | ${card.src} |\n`, 'utf8');
}

function toolNames(data) {
  const blocks = data?.message?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((b) => b?.type === 'tool-call').map((b) => String(b.name ?? 'tool'));
}

function shorten(text, max) {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function extractText(data) {
  const message = data?.message ?? data;
  if (!message || typeof message !== 'object') return '';
  if (typeof message === 'string') return message;
  const blocks = message.content;
  if (!Array.isArray(blocks)) return typeof data?.text === 'string' ? data.text : '';
  return blocks
    .map((b) => {
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return String(b.text ?? '');
      if (b.type === 'tool-call') return `[call ${b.name ?? ''}]`;
      if (b.type === 'tool-result') return `[result] ${typeof b.content === 'string' ? b.content : ''}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
