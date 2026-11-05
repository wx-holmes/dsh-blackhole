// 加载自检：确认入口 import 链能解析（DSH loader 走的就是这条链）
const m = await import('../index.js');
console.log('name =', m.name);
console.log('inject =', JSON.stringify(m.inject));
console.log('apply =', typeof m.apply);

const b = await import('@deepseek-ai/dsh-compaction-basic');
console.log('BasicCompactionEngine =', typeof b.default, 'inject =', JSON.stringify(b.default?.inject ?? null));

const proto = b.default?.prototype ?? {};
console.log('prototype methods =', Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor').slice(0, 20).join(', '));
