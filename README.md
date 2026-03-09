# MeshClaw: OpenClaw Meshtastic Channel Plugin

<p align="center">
  <a href="https://www.npmjs.com/package/@seeed-studio/meshtastic">
    <img alt="npm version" src="https://img.shields.io/npm/v/@seeed-studio/meshtastic.svg" />
  </a>
  <a href="https://www.npmjs.com/package/@seeed-studio/meshtastic">
    <img alt="license" src="https://img.shields.io/npm/l/@seeed-studio/meshtastic.svg" />
  </a>
</p>

<!-- LANG_SWITCHER_START -->
<p align="center">
  <b>English</b> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.fr.md">Français</a> | <a href="README.pt.md">Português</a> | <a href="README.es.md">Español</a>
</p>
<!-- LANG_SWITCHER_END -->

<p align="center">
  <img src="media/GoMeshClaw.png" width="700" alt="Meshtastic LoRa hardware" />
</p>

**MeshClaw** is an OpenClaw channel plugin that lets your AI gateway send and receive messages over Meshtastic — no internet, no cell towers, just radio waves. Talk to your AI assistant from the mountains, the ocean, or anywhere the grid doesn't reach.

> [!IMPORTANT]
> This repository is an **OpenClaw channel plugin**, not a standalone app.
> You need a running [OpenClaw](https://github.com/openclaw/openclaw) gateway (Node.js 22+) to use it.

[Meshtastic docs][docs] · [Report bug][issues] · [Request feature][issues]

⭐ Star us on GitHub — it motivates us a lot!

## Table of Contents

- [Features](#features)
- [Capabilities & Roadmap](#capabilities--roadmap)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Transport Modes](#transport-modes)
- [Access Control](#access-control)
- [Configuration](#configuration)
- [Demo](#demo)
- [Recommended Hardware](#recommended-hardware)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Development](#development)
- [Contributing](#contributing)

## Features

- **AI Agent Integration** — Bridges OpenClaw AI agents with Meshtastic LoRa mesh networks. Enables intelligent communication without cloud dependency.
- **Three Transport Modes** — Serial (USB), HTTP (WiFi), and MQTT support
- **DM & Group Channels with Access Control** — Supports both conversation modes with DM allowlists, channel response rules, and mention-gating
- **Multi-Account Support** — Run multiple independent connections simultaneously
- **Resilient Mesh Communication** — Auto-reconnect with configurable retries. Handles connection drops gracefully.

## Capabilities & Roadmap

The plugin treats Meshtastic as a first-class channel — just like Telegram or Discord — enabling AI conversations and skill invocation entirely over LoRa radio, without internet dependency.

| Query Information Offline | Cross-Channel Bridge: Send from off-grid, receive anywhere | What's next |
|---|---|---|
| <img src="media/image1.png" alt="Query Information Offline" /> | <img src="media/image2.png" alt="Cross-Channel Bridge" /> | We plan to ingest real-time node data (GPS location, environmental sensors, device status) into OpenClaw's context, enabling the AI to monitor mesh network health and broadcast proactive alerts without waiting for user queries. |

## Prerequisites

- OpenClaw gateway installed and running
- Node.js 22+
- One Meshtastic connection method:
  - Serial device via USB, or
  - HTTP-enabled Meshtastic device on LAN, or
  - MQTT broker access (no local hardware required)

## Quick Start

```bash
# 1) Install plugin from npm
openclaw plugins install @seeed-studio/meshtastic

# 2) Run guided setup
openclaw onboard

# 3) Verify channel status
openclaw channels status --probe
```

<p align="center">
  <img src="media/setup-screenshot.png" width="700" alt="OpenClaw setup wizard" />
</p>

## How It Works

```mermaid
flowchart LR
    subgraph mesh ["LoRa Mesh Network"]
        N["Meshtastic Nodes"]
    end
    subgraph gw ["OpenClaw Gateway"]
        P["MeshClaw Plugin"]
        AI["AI Agent"]
    end
    N -- "Serial (USB)" --> P
    N -- "HTTP (WiFi)" --> P
    N -. "MQTT (Broker)" .-> P
    P <--> AI
```

Inbound messages pass through DM/group policy checks before reaching the AI agent.
Outbound replies are converted to plain text and chunked for radio delivery.

## Transport Modes

| Mode | Best for | Required fields |
|---|---|---|
| `serial` | Local USB-connected node | `transport`, `serialPort` |
| `http` | Node reachable on local network | `transport`, `httpAddress` |
| `mqtt` | No local hardware, shared broker | `transport`, `mqtt.*`, `nodeName` |

Notes:
- `serial` is the default transport.
- `mqtt` defaults: broker `mqtt.meshtastic.org`, topic `msh/US/2/json/#`.
- Region setting applies to Serial/HTTP; MQTT derives region from topic.

## Access Control

### DM Policy (`dmPolicy`)

| Value | Behavior |
|---|---|
| `pairing` (default) | New users require approval before DM chats |
| `open` | Any node can DM |
| `allowlist` | Only IDs in `allowFrom` can DM |

### Group Policy (`groupPolicy`)

| Value | Behavior |
|---|---|
| `disabled` (default) | Ignore group channels |
| `open` | Respond in all group channels |
| `allowlist` | Respond only in configured channels |

You can also require mention per channel (`requireMention`) so the bot only replies when explicitly tagged.

## Configuration

Use `openclaw onboard` for guided setup, or edit config manually with `openclaw config edit`.

### Serial (USB)

```yaml
channels:
  meshtastic:
    transport: serial
    serialPort: /dev/ttyUSB0
    nodeName: OpenClaw
```

### HTTP (WiFi)

```yaml
channels:
  meshtastic:
    transport: http
    httpAddress: meshtastic.local
    nodeName: OpenClaw
```

### MQTT (Broker)

```yaml
channels:
  meshtastic:
    transport: mqtt
    nodeName: OpenClaw
    mqtt:
      broker: mqtt.meshtastic.org
      username: meshdev
      password: large4cats
      topic: "msh/US/2/json/#"
```

### Multi-account

```yaml
channels:
  meshtastic:
    accounts:
      home:
        transport: serial
        serialPort: /dev/ttyUSB0
      remote:
        transport: mqtt
        mqtt:
          broker: mqtt.meshtastic.org
          topic: "msh/US/2/json/#"
```

<details>
<summary><b>Configuration reference</b></summary>

| Key | Type | Default | Notes |
|---|---|---|---|
| `transport` | `serial \| http \| mqtt` | `serial` | Base transport |
| `serialPort` | `string` | - | Required for `serial` |
| `httpAddress` | `string` | `meshtastic.local` | Required for `http` |
| `httpTls` | `boolean` | `false` | HTTP TLS |
| `mqtt.broker` | `string` | `mqtt.meshtastic.org` | MQTT broker host |
| `mqtt.port` | `number` | `1883` | MQTT port |
| `mqtt.username` | `string` | `meshdev` | MQTT username |
| `mqtt.password` | `string` | `large4cats` | MQTT password |
| `mqtt.topic` | `string` | `msh/US/2/json/#` | Subscribe topic |
| `mqtt.publishTopic` | `string` | derived | Optional override |
| `mqtt.tls` | `boolean` | `false` | MQTT TLS |
| `region` | enum | `UNSET` | Serial/HTTP only |
| `nodeName` | `string` | auto-detect | Required for MQTT |
| `dmPolicy` | `open \| pairing \| allowlist` | `pairing` | DM access policy |
| `allowFrom` | `string[]` | - | DM allowlist, e.g. `!aabbccdd` |
| `groupPolicy` | `open \| allowlist \| disabled` | `disabled` | Group channel policy |
| `channels` | `Record<string, object>` | - | Per-channel overrides |
| `textChunkLimit` | `number` | `200` | Allowed range: `50-500` |

</details>

<details>
<summary><b>Environment variable overrides</b></summary>

These variables override default-account fields:

| Variable | Config key |
|---|---|
| `MESHTASTIC_TRANSPORT` | `transport` |
| `MESHTASTIC_SERIAL_PORT` | `serialPort` |
| `MESHTASTIC_HTTP_ADDRESS` | `httpAddress` |
| `MESHTASTIC_MQTT_BROKER` | `mqtt.broker` |
| `MESHTASTIC_MQTT_TOPIC` | `mqtt.topic` |

</details>

## Demo

<div align="center">

https://github.com/user-attachments/assets/837062d9-a5bb-4e0a-b7cf-298e4bdf2f7c

</div>

Fallback: [media/demo.mp4](media/demo.mp4)

## Recommended Hardware

<p align="center">
  <img src="media/XIAOclaw.png" width="760" alt="Meshtastic device with Seeed XIAO module" />
</p>

| Device | Best for | Link |
|---|---|---|
| XIAO ESP32S3 + Wio-SX1262 kit | Entry-level development | [Buy][hw-xiao] |
| Wio Tracker L1 Pro | Portable field gateway | [Buy][hw-wio] |
| SenseCAP Card Tracker T1000-E | Compact tracker | [Buy][hw-sensecap] |

Any Meshtastic-compatible device works. MQTT mode can run without local hardware.

## Troubleshooting

| Symptom | Check |
|---|---|
| Serial cannot connect | Is `serialPort` correct? Does host have device permission? |
| HTTP cannot connect | Is `httpAddress` reachable? Is `httpTls` set correctly? |
| MQTT receives no messages | Is topic region correct? Are broker credentials valid? |
| No DM replies | Check `dmPolicy` and `allowFrom` |
| No group replies | Check `groupPolicy`, allowlist, and mention requirement |

When filing an issue, include transport mode, redacted config, and `openclaw channels status --probe` output.

## Limitations

- LoRa messages are bandwidth-constrained; replies are chunked (`textChunkLimit`, default `200`).
- Rich markdown is stripped before sending to radio devices.
- Mesh quality, range, and latency depend on radio environment and network conditions.

## Development

```bash
git clone https://github.com/Seeed-Solution/openclaw-meshtastic.git
cd openclaw-meshtastic
npm install
openclaw plugins install -l ./openclaw-meshtastic
openclaw channels status --probe
```

No build step is required. OpenClaw loads TypeScript source directly from `index.ts`.

## Contributing

- Open issues and feature requests via [GitHub Issues][issues]
- Pull requests are welcome
- Keep changes aligned with existing TypeScript conventions

<!-- Reference-style links -->
[docs]: https://meshtastic.org/docs/
[issues]: https://github.com/Seeed-Solution/openclaw-meshtastic/issues
[hw-xiao]: https://www.seeedstudio.com/Wio-SX1262-with-XIAO-ESP32S3-p-5982.html
[hw-wio]: https://www.seeedstudio.com/Wio-Tracker-L1-Pro-p-6454.html
[hw-sensecap]: https://www.seeedstudio.com/SenseCAP-Card-Tracker-T1000-E-for-Meshtastic-p-5913.html
