import { makeBlackholeEngine } from '../src/engine.js';

let base;
try {
  const mod = await import('@deepseek-ai/dsh-compaction-basic');
  base = mod.default;
  console.log('OK  basic:', typeof base, base?.name);
} catch (error) {
  console.log('ERR basic:', error?.message ?? error);
  process.exit(1);
}

try {
  const Engine = makeBlackholeEngine(base);
  console.log('OK  engine:', Engine.name, '| inject:', JSON.stringify(Engine.inject));
  const proto = Object.getOwnPropertyNames(Engine.prototype);
  console.log('    methods:', proto.join(', '));
} catch (error) {
  console.log('ERR engine:', error?.message ?? error);
  process.exit(1);
}
