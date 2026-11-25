import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSimulation, DECISION } from '../src/simulator.js';

function baseInput(overrides = {}) {
  return {
    vni: 5000,
    agingTime: 100,
    duplicateWindow: 10,
    vteps: [{ id: 'vtep1' }, { id: 'vtep2' }, { id: 'vtep3' }],
    floodTable: { 5000: ['vtep1', 'vtep2', 'vtep3'] },
    vms: [
      { id: 'vm1', mac: '00:00:00:00:00:11', ip: '10.0.0.11', vtep: 'vtep1' },
      { id: 'vm2', mac: '00:00:00:00:00:12', ip: '10.0.0.12', vtep: 'vtep2' },
    ],
    remoteCache: [],
    events: [],
    ...overrides,
  };
}

function arpRequest(time, overrides = {}) {
  return {
    type: 'arp_request',
    time,
    vni: 5000,
    ingressVtep: 'vtep2',
    senderIp: '10.0.0.12',
    senderMac: '00:00:00:00:00:12',
    targetIp: '10.0.0.11',
    ...overrides,
  };
}

test('目标 VM 在本地时直接本地交付', () => {
  const report = runSimulation(baseInput({
    events: [arpRequest(1, { ingressVtep: 'vtep1', senderIp: '10.0.0.11', senderMac: '00:00:00:00:00:11', targetIp: '10.0.0.11' })],
  }));
  assert.equal(report.decisions[0].decision, DECISION.LOCAL_DELIVER);
  assert.equal(report.decisions[0].blackhole, false);
});

test('缓存命中且未老化时本地代理，不产生黑洞', () => {
  const report = runSimulation(baseInput({
    remoteCache: [
      { vtep: 'vtep2', vni: 5000, ip: '10.0.0.11', mac: '00:00:00:00:00:11', nextHopVtep: 'vtep1', learnedAt: 0 },
    ],
    events: [arpRequest(1)],
  }));
  const d = report.decisions[0];
  assert.equal(d.decision, DECISION.LOCAL_PROXY);
  assert.equal(d.proxiedMac, '00:00:00:00:00:11');
  assert.equal(d.blackhole, false);
  assert.equal(report.blackholes.length, 0);
});

test('缓存未命中先泛洪，真实主机应答后转为本地代理', () => {
  const report = runSimulation(baseInput({
    events: [arpRequest(1), arpRequest(2)],
  }));
  assert.equal(report.decisions[0].decision, DECISION.FLOOD);
  assert.deepEqual(report.decisions[0].floodTo, ['vtep1', 'vtep3']);
  assert.equal(report.decisions[0].answeredBy, 'vtep1');
  assert.equal(report.decisions[1].decision, DECISION.LOCAL_PROXY);
  assert.equal(report.decisions[1].blackhole, false);
});

test('重复 ARP 在抑制窗口内被抑制，不形成广播风暴', () => {
  const events = [0, 1, 2, 3, 4].map((t) => arpRequest(t, { targetIp: '10.0.0.99' }));
  events.push(arpRequest(15, { targetIp: '10.0.0.99' })); // 窗口过后允许再次泛洪
  const report = runSimulation(baseInput({ events }));
  const kinds = report.decisions.map((d) => d.decision);
  assert.deepEqual(kinds, [
    DECISION.FLOOD,
    DECISION.SUPPRESSED_DUPLICATE,
    DECISION.SUPPRESSED_DUPLICATE,
    DECISION.SUPPRESSED_DUPLICATE,
    DECISION.SUPPRESSED_DUPLICATE,
    DECISION.FLOOD,
  ]);
  const stat = report.floodStats.find((f) => f.key.includes('10.0.0.99'));
  assert.equal(stat.floods, 2, '6 次请求只泛洪 2 次');
});

test('缓存老化：过期表项被清除并退化为泛洪', () => {
  const report = runSimulation(baseInput({
    remoteCache: [
      { vtep: 'vtep2', vni: 5000, ip: '10.0.0.11', mac: '00:00:00:00:00:11', nextHopVtep: 'vtep1', learnedAt: 0 },
    ],
    events: [arpRequest(50), arpRequest(150)],
  }));
  assert.equal(report.decisions[0].decision, DECISION.LOCAL_PROXY);
  assert.equal(report.decisions[1].decision, DECISION.FLOOD);
  const expired = report.expiredEntries.filter((e) => e.key === '5000:10.0.0.11');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].vtep, 'vtep2');
});

test('迁移进行中缓存不失效，请求远端转发到旧 VTEP 且无黑洞', () => {
  const report = runSimulation(baseInput({
    remoteCache: [
      { vtep: 'vtep2', vni: 5000, ip: '10.0.0.11', mac: '00:00:00:00:00:11', nextHopVtep: 'vtep1', learnedAt: 0 },
    ],
    events: [
      { type: 'migration', time: 5, vm: 'vm1', from: 'vtep1', to: 'vtep3', phase: 'start' },
      arpRequest(6),
    ],
  }));
  const d = report.decisions[0];
  assert.equal(d.decision, DECISION.REMOTE_FORWARD);
  assert.equal(d.nextHopVtep, 'vtep1');
  assert.equal(d.blackhole, false);
  assert.equal(report.blackholes.length, 0);
});

test('迁移完成前的主机通告被阻止：缓存失效不早于迁移完成', () => {
  const report = runSimulation(baseInput({
    remoteCache: [
      { vtep: 'vtep2', vni: 5000, ip: '10.0.0.11', mac: '00:00:00:00:00:11', nextHopVtep: 'vtep1', learnedAt: 0 },
    ],
    events: [
      { type: 'migration', time: 5, vm: 'vm1', from: 'vtep1', to: 'vtep3', phase: 'start' },
      { type: 'arp_reply', time: 6, vni: 5000, ingressVtep: 'vtep3', senderIp: '10.0.0.11', senderMac: '00:00:00:00:00:11', gratuitous: true },
    ],
  }));
  assert.equal(report.warnings.length, 1);
  assert.equal(report.warnings[0].type, 'premature-invalidation-blocked');
  const entry = report.finalCache.vtep2.find((e) => e.key === '5000:10.0.0.11');
  assert.equal(entry.nextHopVtep, 'vtep1', '迁移完成前缓存仍指向旧 VTEP');
});

test('迁移完成后旧缓存导致代理黑洞，免费 ARP 收敛后恢复', () => {
  const report = runSimulation(baseInput({
    agingTime: 300,
    remoteCache: [
      { vtep: 'vtep2', vni: 5000, ip: '10.0.0.11', mac: '00:00:00:00:00:11', nextHopVtep: 'vtep1', learnedAt: 0 },
    ],
    events: [
      { type: 'migration', time: 5, vm: 'vm1', from: 'vtep1', to: 'vtep3', phase: 'start' },
      { type: 'migration', time: 10, vm: 'vm1', from: 'vtep1', to: 'vtep3', phase: 'complete' },
      arpRequest(11),
      { type: 'arp_reply', time: 12, vni: 5000, ingressVtep: 'vtep3', senderIp: '10.0.0.11', senderMac: '00:00:00:00:00:11', gratuitous: true },
      arpRequest(13),
    ],
  }));
  const [during, after] = report.decisions;
  assert.equal(during.decision, DECISION.LOCAL_PROXY);
  assert.equal(during.blackhole, true, '陈旧缓存导致代理黑洞');
  assert.equal(report.blackholes.length, 1);
  assert.equal(report.blackholes[0].sentToVtep, 'vtep1');
  assert.equal(report.blackholes[0].actualVtep, 'vtep3');
  assert.equal(report.staleCache.length >= 1, true);
  assert.equal(after.decision, DECISION.LOCAL_PROXY);
  assert.equal(after.blackhole, false, '免费 ARP 刷新缓存后不再黑洞');
  assert.equal(after.cachedNextHopVtep, 'vtep3');
});

test('代理响应不能覆盖真实主机表项，真实主机通告可以覆盖代理表项', () => {
  const report = runSimulation(baseInput({
    events: [
      // 真实主机应答：vtep3 学到 vm1 在 vtep1。
      { type: 'arp_reply', time: 1, vni: 5000, ingressVtep: 'vtep1', senderIp: '10.0.0.11', senderMac: '00:00:00:00:00:11', gratuitous: true },
      // 过期代理通告试图把 10.0.0.11 指到 vtep2：必须被拒绝。
      { type: 'proxy_advertisement', time: 2, vtep: 'vtep3', vni: 5000, ip: '10.0.0.11', mac: '00:00:00:00:00:11', nextHopVtep: 'vtep2' },
      // 迁移完成后真实主机从 vtep2 发免费 ARP：允许覆盖。
      { type: 'migration', time: 3, vm: 'vm1', from: 'vtep1', to: 'vtep2', phase: 'complete' },
      { type: 'arp_reply', time: 4, vni: 5000, ingressVtep: 'vtep2', senderIp: '10.0.0.11', senderMac: '00:00:00:00:00:11', gratuitous: true },
    ],
  }));
  assert.equal(report.guardrails.length, 1);
  assert.equal(report.guardrails[0].rejectedSource, 'proxy');
  assert.equal(report.guardrails[0].keptSource, 'real');
  const entry = report.finalCache.vtep3.find((e) => e.key === '5000:10.0.0.11');
  assert.equal(entry.nextHopVtep, 'vtep2');
  assert.equal(entry.source, 'real');
});
