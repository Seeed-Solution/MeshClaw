import mqtt from "mqtt";
import { hexToNodeNum, looksLikeMeshtasticNodeId, nodeNumToHex } from "./normalize.js";
import type { MeshtasticMqttConfig } from "./types.js";

/** Derive the JSON downlink topic from a subscribe topic.
 *  Standard pattern: "msh/REGION/NUM/json/#" → "msh/REGION/NUM/json/mqtt/".
 *  Meshtastic firmware accepts JSON downlinks on the ".../2/json/mqtt/" topic;
 *  a channel named "mqtt" (with downlink enabled) must exist on the gateway.
 *  See https://meshtastic.org/docs/software/integrations/mqtt/ */
function derivePublishTopic(subscribeTopic: string): string {
  if (subscribeTopic.endsWith("/#")) {
    return subscribeTopic.slice(0, -2) + "/mqtt/";
  }
  return subscribeTopic + "/mqtt/";
}

export type MeshtasticMqttTextEvent = {
  senderNodeId: string;
  senderName?: string;
  text: string;
  channelIndex: number;
  channelName?: string;
  isDirect: boolean;
  rxTime: number;
};

export type MeshtasticMqttClientOptions = {
  mqtt: MeshtasticMqttConfig;
  myNodeId?: string;
  abortSignal?: AbortSignal;
  onText?: (event: MeshtasticMqttTextEvent) => void | Promise<void>;
  onStatus?: (status: string) => void;
  onError?: (error: Error) => void;
};

export type MeshtasticMqttClient = {
  sendText: (text: string, destination?: string, channelIndex?: number) => Promise<void>;
  close: () => void;
};

/**
 * Meshtastic MQTT JSON *uplink* message (received from the broker).
 * Text packets arrive as { type: "text", payload: { text }, from, to, channel,
 * sender }, where `from` is the originating node and `sender` is the gateway
 * node that published the packet to MQTT.
 */
type MqttJsonMessage = {
  sender?: string;
  from?: number;
  to?: number;
  type?: string;
  payload?: { text?: string };
  channel?: number;
  channel_name?: string;
};

/**
 * Meshtastic MQTT JSON *downlink* message (published to ".../2/json/mqtt/").
 * `payload` is a plain string and `from` is the numeric node ID of the gateway
 * that will transmit the message. `channel` (index) and `to` are optional.
 */
type MqttJsonDownlink = {
  from: number;
  type: "sendtext";
  payload: string;
  channel?: number;
  to?: number;
};

/** Connect to a Meshtastic mesh via MQTT broker. */
export async function connectMeshtasticMqtt(
  options: MeshtasticMqttClientOptions,
): Promise<MeshtasticMqttClient> {
  const mqttConfig = options.mqtt;
  const broker = mqttConfig.broker ?? "mqtt.meshtastic.org";
  const port = mqttConfig.port ?? 1883;
  const username = mqttConfig.username ?? "meshdev";
  const password = mqttConfig.password ?? "large4cats";
  const topic = mqttConfig.topic ?? "msh/US/2/json/#";
  const publishTopic = mqttConfig.publishTopic ?? derivePublishTopic(topic);
  const protocol = mqttConfig.tls ? "mqtts" : "mqtt";
  const myNodeId = (mqttConfig.myNodeId ?? options.myNodeId)?.toLowerCase();

  if (!myNodeId) {
    options.onStatus?.(
      "warning: myNodeId not set — all messages will be treated as group. " +
        "Set channels.meshtastic.mqtt.myNodeId for DM support.",
    );
  }

  const client = mqtt.connect(`${protocol}://${broker}:${port}`, {
    username,
    password,
    clean: true,
    reconnectPeriod: 5000,
  });

  client.on("connect", () => {
    options.onStatus?.("connected");
    client.subscribe(topic, (err) => {
      if (err) {
        options.onError?.(new Error(`MQTT subscribe failed: ${err.message}`));
      } else {
        options.onStatus?.(`subscribed to ${topic}`);
      }
    });
  });

  client.on("error", (err) => {
    options.onError?.(err);
  });

  client.on("reconnect", () => {
    options.onStatus?.("reconnecting");
  });

  client.on("message", async (_topic, payload) => {
    if (!options.onText) {
      return;
    }

    let msg: MqttJsonMessage;
    try {
      msg = JSON.parse(payload.toString()) as MqttJsonMessage;
    } catch {
      return;
    }

    // Only handle text messages. Received text packets use type "text"
    // ("sendtext" is the downlink verb and never appears on uplink).
    if (msg.type !== "text" || !msg.payload?.text) {
      return;
    }

    // Identify the originating node. `from` is the actual author; `sender` is
    // only the gateway that uploaded the packet to MQTT, so prefer `from`.
    const senderNodeId = msg.from !== undefined
      ? nodeNumToHex(msg.from)
      : msg.sender
        ? msg.sender.toLowerCase()
        : undefined;
    if (!senderNodeId) {
      return;
    }
    if (myNodeId && senderNodeId === myNodeId) {
      return;
    }

    // Determine DM vs broadcast.
    // MQTT JSON: if `to` matches our node ID, it's a direct message.
    const isDirect = myNodeId !== undefined
      && msg.to !== undefined
      && msg.to !== 0xffffffff
      && nodeNumToHex(msg.to).toLowerCase() === myNodeId;

    // The JSON envelope carries no display name (`sender` is the gateway node
    // ID, not a name), so leave senderName unset and let the node ID stand in.
    const event: MeshtasticMqttTextEvent = {
      senderNodeId: senderNodeId.startsWith("!") ? senderNodeId : `!${senderNodeId}`,
      text: msg.payload.text,
      channelIndex: msg.channel ?? 0,
      channelName: msg.channel_name,
      isDirect,
      rxTime: Date.now(),
    };

    try {
      await options.onText(event);
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  if (options.abortSignal) {
    options.abortSignal.addEventListener(
      "abort",
      () => {
        client.end(true);
      },
      { once: true },
    );
  }

  return {
    sendText: async (text, destination, channelIndex) => {
      // Standard Meshtastic JSON downlink: publish to ".../2/json/mqtt/" with
      // { from, type: "sendtext", payload: <string>, channel?, to? }. `payload`
      // is a plain string (not an object) and `from` is the numeric node ID of
      // the gateway that transmits. The gateway needs a channel named "mqtt"
      // with downlink enabled and JSON output on.
      // https://meshtastic.org/docs/software/integrations/mqtt/
      const fromNum = myNodeId ? hexToNodeNum(myNodeId) : 0;
      const message: MqttJsonDownlink = {
        from: fromNum,
        type: "sendtext",
        payload: text,
        ...(channelIndex !== undefined ? { channel: channelIndex } : {}),
        ...(destination && looksLikeMeshtasticNodeId(destination)
          ? { to: hexToNodeNum(destination) }
          : {}),
      };
      client.publish(publishTopic, JSON.stringify(message));
    },
    close: () => {
      client.end(true);
    },
  };
}
