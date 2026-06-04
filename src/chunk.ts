// LoRa text payload is ~230 bytes per frame. The soft limit (textChunkLimit)
// keeps replies short; the hard limit is the most a single frame can carry.
export const MESHTASTIC_CHUNK_LIMIT = 200;
export const MESHTASTIC_HARD_LIMIT = 230;

/**
 * Split a reply into LoRa-sized chunks without breaking words or URLs.
 *
 * Reflows on whitespace, packing tokens up to `limit`. A single token longer
 * than `limit` (typically a URL) is kept whole up to the hard frame limit so
 * links stay valid — it's only hard-split as a last resort when it cannot fit
 * a single frame at all. The previous implementation broke at a fixed offset
 * when no nearby space was found, which sliced long URLs in half and produced
 * two unusable links.
 */
export function chunkText(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= limit) {
    return trimmed ? [trimmed] : [];
  }

  const hardMax = Math.max(limit, MESHTASTIC_HARD_LIMIT);

  // Greedily pack whitespace-separated tokens, never splitting a token.
  const packed: string[] = [];
  let cur = "";
  for (const word of trimmed.split(/\s+/)) {
    if (!word) continue;
    if (cur === "") {
      cur = word;
    } else if (cur.length + 1 + word.length <= limit) {
      cur += " " + word;
    } else {
      packed.push(cur);
      cur = word;
    }
  }
  if (cur) packed.push(cur);

  // A packed entry may still be a single token longer than the soft limit
  // (e.g. a URL). Keep it whole if it fits one frame; otherwise hard-split.
  const chunks: string[] = [];
  for (const entry of packed) {
    if (entry.length <= hardMax) {
      chunks.push(entry);
      continue;
    }
    for (let i = 0; i < entry.length; i += hardMax) {
      chunks.push(entry.slice(i, i + hardMax));
    }
  }
  return chunks;
}
