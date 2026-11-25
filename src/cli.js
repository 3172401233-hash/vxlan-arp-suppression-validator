#!/usr/bin/env node
// 命令行入口：读取模拟输入 JSON，输出 ARP 决策报告。
// 所有报文均为模拟，不发送任何真实网络流量。
import { readFileSync } from 'node:fs';
import { runSimulation } from './simulator.js';

const file = process.argv[2];
if (!file) {
  console.error('用法: node src/cli.js <input.json>');
  process.exit(1);
}

const input = JSON.parse(readFileSync(file, 'utf8'));
const report = runSimulation(input);

console.log('=== ARP 决策 ===');
for (const d of report.decisions) {
  const extra =
    d.decision === 'LOCAL_PROXY' ? ` mac=${d.proxiedMac} via=${d.cachedNextHopVtep}` :
    d.decision === 'REMOTE_FORWARD' ? ` nextHop=${d.nextHopVtep}` :
    d.decision === 'FLOOD' ? ` to=[${d.floodTo.join(',')}]` : '';
  const bh = d.blackhole ? '  [黑洞!]' : '';
  console.log(`t=${d.time} ${d.ingressVtep} ${d.senderIp}->${d.targetIp}: ${d.decision}${extra}${bh}`);
}

console.log('\n=== 陈旧缓存 ===');
for (const s of report.staleCache) {
  console.log(`t=${s.time} ${s.vtep} ${s.ip} -> 缓存=${s.cachedVtep} 实际=${s.actualVtep}`);
}
if (report.staleCache.length === 0) console.log('(无)');

console.log('\n=== 流量黑洞 ===');
for (const b of report.blackholes) {
  console.log(`t=${b.time} ${b.vtep} ${b.targetIp} 发往=${b.sentToVtep} 实际=${b.actualVtep}: ${b.cause}`);
}
if (report.blackholes.length === 0) console.log('(无)');

console.log('\n=== 完整报告 (JSON) ===');
console.log(JSON.stringify(report, null, 2));
