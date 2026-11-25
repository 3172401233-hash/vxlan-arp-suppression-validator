# vxlan-arp-suppression-validator

验证 VXLAN ARP 抑制、泛洪和主机迁移的模拟器。

> **免责声明：本项目中所有 ARP 请求、ARP 响应、免费 ARP、泛洪、单播转发等
> “报文”均为内存中的模拟事件，不会构造、发送或接收任何真实网络流量。**

## 背景

VXLAN 开启 ARP 抑制后，VTEP 会用本地缓存的 MAC/IP 绑定代答 ARP。虚拟机迁移到
新 VTEP 后，旧 VTEP（及其他 VTEP）可能仍缓存指向旧位置的远端 MAC，后续 ARP
请求被错误代理，流量被发往不存在的位置，形成流量黑洞。本工具按时间线重放模拟
事件，计算每个 ARP 请求应当 **本地代理（LOCAL_PROXY）**、**远端转发
（REMOTE_FORWARD）** 还是 **泛洪（FLOOD）**，并输出陈旧缓存与流量黑洞。

## 不变量

- **缓存失效不能早于迁移完成**：迁移开始但未完成期间，旧位置仍是权威位置，
  请求单播转发到旧 VTEP；迁移完成前到达的“新位置主机通告”被拒绝并记录警告。
- **重复 ARP 不能形成广播风暴**：相同 `(vni, 源IP, 目标IP)` 的请求在
  `duplicateWindow` 抑制窗口内只泛洪一次，其余记为 `SUPPRESSED_DUPLICATE`。
- **代理响应不能覆盖真实主机**：缓存来源优先级为 `real > config > proxy`，
  代理通告无法覆盖真实主机学到的表项，违规写入被拒绝并记录在 `guardrails`。

## 运行

需要 Node.js >= 24（开发验证版本 24.16.0）。

```sh
node src/cli.js examples/migration.json   # 运行模拟示例
node --test                               # 运行测试
```

## 输入格式

```jsonc
{
  "vni": 5000,                 // 默认 VNI（VM 可单独覆盖）
  "agingTime": 300,            // 缓存老化时间
  "duplicateWindow": 10,       // 重复 ARP 泛洪抑制窗口
  "vteps": [{ "id": "vtep1" }],
  "floodTable": { "5000": ["vtep1", "vtep2", "vtep3"] },
  "vms": [{ "id": "vm1", "mac": "00:..:11", "ip": "10.0.0.11", "vtep": "vtep1" }],
  "remoteCache": [{            // 初始远端缓存（如 EVPN 下发）
    "vtep": "vtep2", "vni": 5000, "ip": "10.0.0.11",
    "mac": "00:..:11", "nextHopVtep": "vtep1", "learnedAt": 0
  }],
  "events": [                  // 按 time 排序重放
    { "type": "arp_request", "time": 1, "vni": 5000, "ingressVtep": "vtep2",
      "senderIp": "10.0.0.12", "senderMac": "00:..:12", "targetIp": "10.0.0.11" },
    { "type": "arp_reply", "time": 12, "vni": 5000, "ingressVtep": "vtep3",
      "senderIp": "10.0.0.11", "senderMac": "00:..:11", "gratuitous": true },
    { "type": "migration", "time": 5, "vm": "vm1",
      "from": "vtep1", "to": "vtep3", "phase": "start" },   // 或 "complete"
    { "type": "proxy_advertisement", "time": 2, "vtep": "vtep3", "vni": 5000,
      "ip": "10.0.0.11", "mac": "00:..:11", "nextHopVtep": "vtep2" }
  ]
}
```

## 决策类型

| 决策 | 含义 |
| --- | --- |
| `LOCAL_DELIVER` | 目标 VM 在入向 VTEP 本地，直接交付，由真实主机应答 |
| `LOCAL_PROXY` | 缓存命中且未老化，VTEP 代答 ARP |
| `REMOTE_FORWARD` | 迁移进行中，缓存保持有效，请求单播转发到旧 VTEP |
| `FLOOD` | 无缓存表项，按泛洪表头端复制 |
| `SUPPRESSED_DUPLICATE` | 抑制窗口内的重复请求，不再泛洪 |

## 输出

- `decisions`：每个 ARP 请求的决策、原因及是否黑洞。
- `staleCache`：陈旧缓存（缓存指向的 VTEP 已不再托管该 VM）。
- `blackholes`：流量黑洞（代理/转发指向不存在的位置）。
- `expiredEntries` / `warnings` / `guardrails`：老化记录、过早失效阻止、
  代理覆盖真实主机的拦截记录。
- `floodStats`：每个去重键的泛洪次数，用于验证广播抑制。

## 测试

`node --test` 覆盖：虚拟机迁移（进行中转发、完成后黑洞、免费 ARP 收敛、
过早失效阻止）、缓存老化、广播抑制、本地交付、代理不覆盖真实主机。
