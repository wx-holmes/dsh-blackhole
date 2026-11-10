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
    // 2026-11-10 02:2x（书同文提的「压缩只剩骨架」）：卡片补两样，都不花模型钱——
    // rationale：这一段里「为什么这么选」的原话（因为/所以/宁可/否则…），
    // pointer：回取指针，指回这一段原文，要细节直接 bh_restore_span 取。
    rationale: deriveRationale(events),
    pointer: { session: sid, seqFrom: first.seq, seqTo: last.seq, how: 'bh_restore_span' },
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

/** 规则摘要（不调用模型）：首条用户句 + 末条助手句 + 工具调用清单 + 一行「为什么」。 */
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
  const why = deriveRationale(events);
  if (why) parts.push(`为什么：${shorten(why, 80)}`);
  if (!parts.length) parts.push(`${events.length} 条事件，无文本可摘`);
  return parts.join('；');
}

/**
 * 「为什么这么选」：从这一段原文里挑带因果/取舍的原话，不调模型、不改写。
 * 2026-11-10 02:2x 加：29 次压缩后只剩「做事、快点、完成」，因为卡片只记了做了什么、
 * 没记为什么。这里把「因为/所以/宁可/否则/我选了X不选Y」这类句子原样抽出来（最多两条），
 * 让下一轮看得见决策依据；要展开还有 pointer 指回原文。
 * 抽不到就返回空串——不编。
 */
export function deriveRationale(events, { maxItems = 2, maxChars = 70 } = {}) {
  const cues = ['因为', '所以', '原因是', '要避免', '否则', '宁可', '而不是', '不选', '权衡', '代价是'];
  // 先看助手说的（决策在那边），没有再退回用户说的——用户原话里也常带「因为」。
  const fromAssistant = events.filter((e) => e.type === 'assistant/message').map((e) => extractText(e.data));
  const fromUser = events.filter((e) => e.type === 'user/message').map((e) => extractText(e.data));
  const picked = [];
  for (const bucket of [fromAssistant, fromUser]) {
    for (const chunk of bucket) {
      for (const raw of String(chunk ?? '').replace(/\\n/g, '\n').split(/[\n。！？!?；;]/)) {
        const line = raw
          .replace(/\s+/g, ' ')
          .replace(/[*`]+/g, '')
          .trim();
        if (line.length < 6 || line.length > 200) continue;
        // 过滤注入进来的设定/记忆文本，别把人格卡当「决策依据」（2026-11-10 实测踩到）。
        if (/【|记忆卡|角色扮演|preset|persona|^\s*-\s|^\[call /.test(line)) continue;
        if (!cues.some((cue) => line.includes(cue))) continue;
        const short = shorten(line, maxChars);
        if (short && !picked.includes(short)) picked.push(short);
        if (picked.length >= maxItems) return picked.join('｜');
      }
    }
  }
  return picked.join('｜');
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
      [
        '# 上下文索引',
        '',
        '> 每行一段被归纳的对话；原文在 src 列，用 recall 取回。',
        '',
        '| 日期 | 标题 | 区间 | 为什么 | 原文 |',
        '|---|---|---|---|---|',
        '',
      ].join('\n'),
      'utf8'
    );
  }
  // 老表头没有「为什么」列时按 4 列写，不破坏已有表格对齐（2026-11-10 加）。
  const head = fs.readFileSync(md, 'utf8').slice(0, 800);
  const withWhy = head.includes('| 为什么 |');
  const safe = (v) => String(v ?? '').replace(/\|/g, '\\|');
  const why = safe(card.rationale ?? '') || '—';
  const row = withWhy
    ? `| ${card.date} | ${safe(card.title)} | ${card.range[0]}-${card.range[1]} | ${why} | ${card.src} |\n`
    : `| ${card.date} | ${safe(card.title)} | ${card.range[0]}-${card.range[1]} | ${card.src} |\n`;
  fs.appendFileSync(md, row, 'utf8');
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
