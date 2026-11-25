// VXLAN ARP 抑制模拟引擎。
// 注意：本模块只进行纯内存计算，所有 ARP 请求/响应、泛洪、迁移均为模拟事件，
// 不会构造或发送任何真实网络报文。

export const DECISION = {
  LOCAL_DELIVER: 'LOCAL_DELIVER',
  LOCAL_PROXY: 'LOCAL_PROXY',
  REMOTE_FORWARD: 'REMOTE_FORWARD',
  FLOOD: 'FLOOD',
  SUPPRESSED_DUPLICATE: 'SUPPRESSED_DUPLICATE',
};

// 缓存来源优先级：真实主机通告 > 初始配置 > 代理通告。
// 代理响应永远不能覆盖真实主机学到的表项。
const SOURCE_RANK = { proxy: 1, config: 2, real: 3 };

const keyOf = (vni, ip) => `${vni}:${ip}`;

export function runSimulation(input) {
  const agingTime = input.agingTime ?? 300;
  const duplicateWindow = input.duplicateWindow ?? 10;

  const vteps = new Map();
  for (const v of input.vteps ?? []) {
    vteps.set(v.id, { id: v.id, cache: new Map() });
  }

  const floodTable = new Map();
  for (const [vni, peers] of Object.entries(input.floodTable ?? {})) {
    floodTable.set(Number(vni), [...peers]);
  }

  const vms = new Map();
  const vmByMac = new Map();
  const vmByIp = new Map();
  const location = new Map(); // vmId -> 当前所在 vtepId
  for (const vm of input.vms ?? []) {
    const record = { ...vm, vni: vm.vni ?? input.vni, mac: vm.mac.toLowerCase() };
    vms.set(record.id, record);
    vmByMac.set(record.mac, record);
    vmByIp.set(keyOf(record.vni, record.ip), record);
    location.set(record.id, record.vtep);
  }

  // 初始远端缓存（例如 BGP EVPN 下发的 MAC/IP 绑定）。
  for (const entry of input.remoteCache ?? []) {
    const vtep = vteps.get(entry.vtep);
    if (!vtep) continue;
    const learnedAt = entry.learnedAt ?? 0;
    vtep.cache.set(keyOf(entry.vni, entry.ip), {
      mac: entry.mac.toLowerCase(),
      nextHopVtep: entry.nextHopVtep,
      learnedAt,
      expiresAt: learnedAt + agingTime,
      source: entry.source ?? 'config',
    });
  }

  const pending = new Map(); // vmId -> { from, to, startedAt }，迁移未完成期间 VM 仍在 from
  const lastFlood = new Map();
  const floodCounts = new Map();

  const decisions = [];
  const blackholes = [];
  const staleCache = [];
  const expiredEntries = [];
  const warnings = [];
  const guardrails = [];
  const generatedReplies = [];
  const staleSeen = new Set();

  function expire(vtepId, time) {
    const vtep = vteps.get(vtepId);
    for (const [key, entry] of vtep.cache) {
      if (entry.expiresAt <= time) {
        vtep.cache.delete(key);
        expiredEntries.push({
          time, vtep: vtepId, key, mac: entry.mac, nextHopVtep: entry.nextHopVtep,
        });
      }
    }
  }

  function expireAll(time) {
    for (const id of vteps.keys()) expire(id, time);
  }

  function learnCache(vtepId, vni, ip, mac, nextHopVtep, source, time) {
    const vtep = vteps.get(vtepId);
    if (!vtep) return false;
    const key = keyOf(vni, ip);
    const existing = vtep.cache.get(key);
    if (
      existing &&
      existing.expiresAt > time &&
      SOURCE_RANK[source] < SOURCE_RANK[existing.source]
    ) {
      guardrails.push({
        time, vtep: vtepId, vni, ip,
        rejectedSource: source,
        keptSource: existing.source,
        reason: '代理/低优先级通告不能覆盖真实主机表项',
      });
      return false;
    }
    vtep.cache.set(key, {
      mac: mac.toLowerCase(),
      nextHopVtep,
      learnedAt: time,
      expiresAt: time + agingTime,
      source,
    });
    return true;
  }

  function markStaleIfNeeded(time, vtepId, vni, ip, entry) {
    const vm = vmByMac.get(entry.mac) ?? vmByIp.get(keyOf(vni, ip));
    if (!vm) return false;
    const actual = location.get(vm.id);
    if (actual === entry.nextHopVtep) return false;
    const sighting = `${vtepId}|${vni}|${ip}|${entry.nextHopVtep}|${actual}`;
    if (!staleSeen.has(sighting)) {
      staleSeen.add(sighting);
      staleCache.push({
        time, vtep: vtepId, vni, ip, mac: entry.mac,
        cachedVtep: entry.nextHopVtep,
        actualVtep: actual,
        reason: '缓存指向的 VTEP 已不再托管该虚拟机',
      });
    }
    return true;
  }

  function handleArpRequest(ev, index) {
    const { vni, ingressVtep, time } = ev;
    expireAll(time);
    // 请求方是直连在入向 VTEP 上的真实主机，先学习。
    if (ev.senderMac) {
      learnCache(ingressVtep, vni, ev.senderIp, ev.senderMac, ingressVtep, 'real', time);
    }

    const targetVm = vmByIp.get(keyOf(vni, ev.targetIp));
    const base = {
      eventIndex: index, time, vni, ingressVtep,
      senderIp: ev.senderIp, targetIp: ev.targetIp,
    };

    // 目标就在本 VTEP：直接本地交付，由真实主机自己应答。
    if (targetVm && location.get(targetVm.id) === ingressVtep) {
      decisions.push({
        ...base,
        decision: DECISION.LOCAL_DELIVER,
        reason: '目标 VM 就在入向 VTEP 本地，直接交付，由真实主机应答',
        blackhole: false,
      });
      learnCache(ingressVtep, vni, targetVm.ip, targetVm.mac, ingressVtep, 'real', time);
      generatedReplies.push({ time, vni, from: targetVm.id, to: ev.senderIp, kind: 'real', via: ingressVtep });
      return;
    }

    const entry = vteps.get(ingressVtep)?.cache.get(keyOf(vni, ev.targetIp));

    if (entry) {
      const migration = targetVm ? pending.get(targetVm.id) : null;
      const stale = markStaleIfNeeded(time, ingressVtep, vni, ev.targetIp, entry);

      // 迁移进行中：缓存失效不能早于迁移完成，旧位置仍是权威位置。
      // 为避免代理出可能过期的 MAC，改为单播转发到旧 VTEP（VM 仍在那里）。
      if (migration && entry.nextHopVtep === migration.from) {
        decisions.push({
          ...base,
          decision: DECISION.REMOTE_FORWARD,
          nextHopVtep: entry.nextHopVtep,
          cachedMac: entry.mac,
          reason: '迁移进行中，缓存保持有效至迁移完成；请求单播转发到旧 VTEP',
          blackhole: false,
        });
        return;
      }

      decisions.push({
        ...base,
        decision: DECISION.LOCAL_PROXY,
        proxiedMac: entry.mac,
        cachedNextHopVtep: entry.nextHopVtep,
        reason: '缓存命中且未老化，VTEP 代答 ARP',
        blackhole: stale,
      });
      generatedReplies.push({ time, vni, from: ingressVtep, to: ev.senderIp, kind: 'proxy', mac: entry.mac });
      if (stale) {
        blackholes.push({
          time, vtep: ingressVtep, vni,
          targetIp: ev.targetIp, mac: entry.mac,
          sentToVtep: entry.nextHopVtep,
          actualVtep: targetVm ? location.get(targetVm.id) : null,
          cause: '迁移完成后旧 VTEP 仍缓存远端 MAC，代理应答把流量指向不存在的位置',
        });
      }
      return;
    }

    // 缓存未命中：泛洪，但相同请求在抑制窗口内不重复泛洪，防止广播风暴。
    const dupKey = `${vni}|${ev.senderIp}|${ev.targetIp}`;
    const last = lastFlood.get(dupKey);
    if (last !== undefined && time - last < duplicateWindow) {
      decisions.push({
        ...base,
        decision: DECISION.SUPPRESSED_DUPLICATE,
        reason: `相同请求在 ${duplicateWindow} 抑制窗口内已泛洪过，重复泛洪被抑制`,
        blackhole: false,
      });
      return;
    }
    lastFlood.set(dupKey, time);
    floodCounts.set(dupKey, (floodCounts.get(dupKey) ?? 0) + 1);

    const peers = (floodTable.get(vni) ?? []).filter((p) => p !== ingressVtep);
    let answeredBy = null;
    if (targetVm) {
      const loc = location.get(targetVm.id);
      if (peers.includes(loc)) answeredBy = loc;
    }
    decisions.push({
      ...base,
      decision: DECISION.FLOOD,
      floodTo: peers,
      answeredBy,
      reason: '无缓存表项，按泛洪表做头端复制',
      blackhole: false,
    });
    if (answeredBy) {
      // 真实主机应答，请求方学到真实位置。
      learnCache(ingressVtep, vni, targetVm.ip, targetVm.mac, answeredBy, 'real', time);
      generatedReplies.push({ time, vni, from: targetVm.id, to: ev.senderIp, kind: 'real', via: answeredBy });
    }
  }

  function handleArpReply(ev) {
    const { vni, ingressVtep, time } = ev;
    expireAll(time);
    const vm = vmByMac.get((ev.senderMac ?? '').toLowerCase());

    // 不变量：缓存失效不能早于迁移完成。
    // 迁移完成前，来自目标 VTEP 的“真实主机”通告视为过早，拒绝学习。
    if (vm) {
      const migration = pending.get(vm.id);
      if (migration && ingressVtep === migration.to) {
        warnings.push({
          time,
          type: 'premature-invalidation-blocked',
          vm: vm.id,
          vtep: ingressVtep,
          reason: '迁移完成前收到来自目标 VTEP 的主机通告，缓存失效被推迟到迁移完成之后',
        });
        return;
      }
    }

    learnCache(ingressVtep, vni, ev.senderIp, ev.senderMac, ingressVtep, 'real', time);
    if (ev.gratuitous) {
      // 免费 ARP 沿泛洪表传播，刷新所有 VTEP 的缓存（用于迁移后的收敛）。
      for (const peer of floodTable.get(vni) ?? []) {
        if (peer !== ingressVtep) {
          learnCache(peer, vni, ev.senderIp, ev.senderMac, ingressVtep, 'real', time);
        }
      }
    }
  }

  function handleProxyAdvertisement(ev) {
    // 线路上被其他 VTEP 听到的代理应答：以 proxy 优先级学习，不能覆盖真实主机表项。
    expireAll(ev.time);
    learnCache(ev.vtep, ev.vni, ev.ip, ev.mac, ev.nextHopVtep, 'proxy', ev.time);
  }

  function handleMigration(ev) {
    if (ev.phase === 'start') {
      pending.set(ev.vm, { from: ev.from, to: ev.to, startedAt: ev.time });
    } else {
      // 迁移完成才切换位置；各 VTEP 的远端缓存不主动清除，
      // 只能依靠老化或真实主机通告收敛。
      location.set(ev.vm, ev.to);
      pending.delete(ev.vm);
    }
  }

  const events = (input.events ?? [])
    .map((ev, i) => ({ ...ev, _i: i }))
    .sort((a, b) => a.time - b.time || a._i - b._i);

  events.forEach((ev, index) => {
    switch (ev.type) {
      case 'arp_request':
        handleArpRequest(ev, index);
        break;
      case 'arp_reply':
        handleArpReply(ev);
        break;
      case 'proxy_advertisement':
        handleProxyAdvertisement(ev);
        break;
      case 'migration':
        handleMigration(ev);
        break;
      default:
        warnings.push({ time: ev.time, type: 'unknown-event', eventType: ev.type });
    }
  });

  // 结束时再做一次老化与陈旧缓存扫描。
  const finalTime = events.length ? events[events.length - 1].time : 0;
  expireAll(finalTime);
  for (const [vtepId, vtep] of vteps) {
    for (const [key, entry] of vtep.cache) {
      const sep = key.indexOf(':');
      markStaleIfNeeded(finalTime, vtepId, Number(key.slice(0, sep)), key.slice(sep + 1), entry);
    }
  }

  const finalCache = {};
  for (const [vtepId, vtep] of vteps) {
    finalCache[vtepId] = [...vtep.cache.entries()].map(([key, entry]) => ({ key, ...entry }));
  }

  return {
    decisions,
    blackholes,
    staleCache,
    expiredEntries,
    warnings,
    guardrails,
    generatedReplies,
    floodStats: [...floodCounts.entries()].map(([key, floods]) => ({ key, floods })),
    finalCache,
  };
}
