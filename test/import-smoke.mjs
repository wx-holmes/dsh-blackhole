import os from 'node:os';
import path from 'node:path';
import { makeBlackholeEngine } from '../src/engine.js';

// 单测别往生产 trace.log 里写：trace 路径走环境变量。
process.env.BLACKHOLE_TRACE = path.join(os.tmpdir(), `bh-trace-${path.basename(process.argv[1] ?? 'test')}-${process.pid}.log`);
process.env.BLACKHOLE_SAMPLE = path.join(os.tmpdir(), `bh-sample-${path.basename(process.argv[1] ?? 'test')}-${process.pid}.jsonl`);

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
