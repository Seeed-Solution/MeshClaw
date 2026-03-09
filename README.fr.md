# MeshClaw : Plugin de canal OpenClaw pour Meshtastic

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
  <a href="README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a> | <b>Français</b> | <a href="README.pt.md">Português</a> | <a href="README.es.md">Español</a>
</p>
<!-- LANG_SWITCHER_END -->

<p align="center">
  <img src="media/GoMeshClaw.png" width="700" alt="Matériel LoRa Meshtastic" />
</p>

MeshClaw est un plugin de canal OpenClaw qui connecte votre passerelle AI Agent à des réseaux mesh LoRa Meshtastic via Serial (USB), HTTP (WiFi) ou MQTT.

> [!IMPORTANT]
> Ce dépôt est un **plugin de canal OpenClaw**, pas une application autonome.
> Une passerelle [OpenClaw](https://github.com/openclaw/openclaw) (Node.js 22+) est requise pour utiliser ce plugin.

[Documentation Meshtastic][docs] · [Signaler un bug][issues] · [Demander une fonctionnalité][issues]

## Table des matières

- [Prérequis](#prérequis)
- [Démarrage rapide](#démarrage-rapide)
- [Fonctionnement](#fonctionnement)
- [Fonctionnalités clés](#fonctionnalités-clés)
- [Modes de transport](#modes-de-transport)
- [Contrôle d'accès](#contrôle-daccès)
- [Configuration](#configuration)
- [Démo](#démo)
- [Matériel recommandé](#matériel-recommandé)
- [Dépannage](#dépannage)
- [Limitations](#limitations)
- [Développement](#développement)
- [Contribution](#contribution)
- [Licence](#licence)

## Prérequis

- Passerelle OpenClaw installée et en cours d'exécution
- Node.js 22+
- Une méthode de connexion Meshtastic :
  - Appareil Serial via USB, ou
  - Appareil Meshtastic avec HTTP activé sur le réseau local, ou
  - Accès à un broker MQTT (aucun matériel local requis)

## Démarrage rapide

```bash
# 1) Installation du plugin depuis npm
openclaw plugins install @seeed-studio/meshtastic

# 2) Lancer la configuration guidée
openclaw onboard

# 3) Vérifier l'état du canal
openclaw channels status --probe
```

<p align="center">
  <img src="media/setup-screenshot.png" width="700" alt="Assistant de configuration OpenClaw" />
</p>

## Fonctionnement

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

Les messages entrants passent par les vérifications de politique de messages privés/canaux de groupe avant d'atteindre l'AI Agent.
Les réponses sortantes sont converties en texte brut et découpées (chunked) pour la transmission radio.

## Fonctionnalités clés

- **Trois transports** : Serial, HTTP et MQTT
- **Contrôles de politique de messages privés** : `pairing`, `open` ou `allowlist`
- **Contrôles de politique de groupe** : `disabled`, `open` ou `allowlist`
- **Filtrage par @mention** : ne répondre dans les groupes que lorsqu'on est mentionné (optionnel)
- **Support multi-comptes** : exécuter plusieurs connexions Meshtastic indépendantes
- **Gestion résiliente des transports** : comportement de reconnexion pour les liens instables

## Modes de transport

| Mode | Idéal pour | Champs requis |
|---|---|---|
| `serial` | Nœud local connecté en USB | `transport`, `serialPort` |
| `http` | Nœud accessible sur le réseau local | `transport`, `httpAddress` |
| `mqtt` | Sans matériel local, broker partagé | `transport`, `mqtt.*`, `nodeName` |

Notes :
- `serial` est le transport par défaut.
- Valeurs par défaut MQTT : broker `mqtt.meshtastic.org`, topic `msh/US/2/json/#`.
- Le paramètre de région s'applique à Serial/HTTP ; MQTT déduit la région du topic.

## Contrôle d'accès

### Politique de messages privés (`dmPolicy`)

| Valeur | Comportement |
|---|---|
| `pairing` (défaut) | Les nouveaux utilisateurs doivent être approuvés avant les conversations privées |
| `open` | Tout nœud peut envoyer des messages privés |
| `allowlist` | Seuls les IDs dans `allowFrom` peuvent envoyer des messages privés |

### Politique de groupe (`groupPolicy`)

| Valeur | Comportement |
|---|---|
| `disabled` (défaut) | Ignorer les canaux de groupe |
| `open` | Répondre dans tous les canaux de groupe |
| `allowlist` | Répondre uniquement dans les canaux configurés |

Vous pouvez aussi exiger une mention par canal (`requireMention`) pour que le bot ne réponde que lorsqu'il est explicitement tagué.

## Configuration

Utilisez `openclaw onboard` pour la configuration guidée, ou éditez la configuration manuellement avec `openclaw config edit`.

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

### Multi-compte

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
<summary><b>Référence de configuration</b></summary>

| Clé | Type | Défaut | Notes |
|---|---|---|---|
| `transport` | `serial \| http \| mqtt` | `serial` | Transport de base |
| `serialPort` | `string` | - | Requis pour `serial` |
| `httpAddress` | `string` | `meshtastic.local` | Requis pour `http` |
| `httpTls` | `boolean` | `false` | HTTP TLS |
| `mqtt.broker` | `string` | `mqtt.meshtastic.org` | Hôte du broker MQTT |
| `mqtt.port` | `number` | `1883` | Port MQTT |
| `mqtt.username` | `string` | `meshdev` | Nom d'utilisateur MQTT |
| `mqtt.password` | `string` | `large4cats` | Mot de passe MQTT |
| `mqtt.topic` | `string` | `msh/US/2/json/#` | Topic d'abonnement |
| `mqtt.publishTopic` | `string` | derived | Remplacement optionnel |
| `mqtt.tls` | `boolean` | `false` | MQTT TLS |
| `region` | enum | `UNSET` | Serial/HTTP uniquement |
| `nodeName` | `string` | auto-detect | Requis pour MQTT |
| `dmPolicy` | `open \| pairing \| allowlist` | `pairing` | Politique d'accès aux messages privés |
| `allowFrom` | `string[]` | - | Liste autorisée pour messages privés, ex. `!aabbccdd` |
| `groupPolicy` | `open \| allowlist \| disabled` | `disabled` | Politique des canaux de groupe |
| `channels` | `Record<string, object>` | - | Remplacements par canal |
| `textChunkLimit` | `number` | `200` | Plage autorisée : `50-500` |

</details>

<details>
<summary><b>Remplacements par variables d'environnement</b></summary>

Ces variables remplacent les champs du compte par défaut :

| Variable | Clé de config |
|---|---|
| `MESHTASTIC_TRANSPORT` | `transport` |
| `MESHTASTIC_SERIAL_PORT` | `serialPort` |
| `MESHTASTIC_HTTP_ADDRESS` | `httpAddress` |
| `MESHTASTIC_MQTT_BROKER` | `mqtt.broker` |
| `MESHTASTIC_MQTT_TOPIC` | `mqtt.topic` |

</details>

## Démo

<div align="center">

https://github.com/user-attachments/assets/837062d9-a5bb-4e0a-b7cf-298e4bdf2f7c

</div>

Alternative : [media/demo.mp4](media/demo.mp4)

## Matériel recommandé

<p align="center">
  <img src="media/XIAOclaw.png" width="760" alt="Appareil Meshtastic avec module Seeed XIAO" />
</p>

| Appareil | Idéal pour | Lien |
|---|---|---|
| Kit XIAO ESP32S3 + Wio-SX1262 | Développement débutant | [Acheter][hw-xiao] |
| Wio Tracker L1 Pro | Passerelle de terrain portable | [Acheter][hw-wio] |
| SenseCAP Card Tracker T1000-E | Tracker compact | [Acheter][hw-sensecap] |

Tout appareil compatible Meshtastic fonctionne. Le mode MQTT peut fonctionner sans matériel local.

## Dépannage

| Symptôme | Vérification |
|---|---|
| Serial ne se connecte pas | Le `serialPort` est-il correct ? L'hôte a-t-il les permissions sur l'appareil ? |
| HTTP ne se connecte pas | L'`httpAddress` est-il accessible ? Le `httpTls` est-il correctement défini ? |
| MQTT ne reçoit pas de messages | La région du topic est-elle correcte ? Les identifiants du broker sont-ils valides ? |
| Pas de réponses aux messages privés | Vérifiez `dmPolicy` et `allowFrom` |
| Pas de réponses de groupe | Vérifiez `groupPolicy`, la liste autorisée et l'exigence de mention |

Lors de la création d'une issue, joignez le mode de transport, la configuration (sans les secrets) et la sortie de `openclaw channels status --probe`.

## Limitations

- Les messages LoRa sont limités en bande passante ; les réponses sont découpées (`textChunkLimit`, défaut `200`).
- Le markdown enrichi est supprimé avant l'envoi aux appareils radio.
- La qualité du mesh, la portée et la latence dépendent de l'environnement radio et des conditions du réseau.

## Développement

```bash
git clone https://github.com/Seeed-Solution/openclaw-meshtastic.git
cd openclaw-meshtastic
npm install
openclaw plugins install -l ./openclaw-meshtastic
openclaw channels status --probe
```

Aucune étape de build n'est requise. OpenClaw charge le source TypeScript directement depuis `index.ts`.

## Contribution

- Ouvrez des issues et demandes de fonctionnalités via [GitHub Issues][issues]
- Les Pull Requests sont les bienvenues
- Gardez les changements alignés avec les conventions TypeScript existantes

## Licence

MIT

<!-- Reference-style links -->
[docs]: https://meshtastic.org/docs/
[issues]: https://github.com/Seeed-Solution/openclaw-meshtastic/issues
[hw-xiao]: https://www.seeedstudio.com/Wio-SX1262-with-XIAO-ESP32S3-p-5982.html
[hw-wio]: https://www.seeedstudio.com/Wio-Tracker-L1-Pro-p-6454.html
[hw-sensecap]: https://www.seeedstudio.com/SenseCAP-Card-Tracker-T1000-E-for-Meshtastic-p-5913.html