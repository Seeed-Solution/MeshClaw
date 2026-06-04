// LoRa text payload is ~230 bytes per frame. The soft limit (textChunkLimit)
// keeps replies short; MESHTASTIC_HARD_LIMIT is the most a single frame can
// carry and is enforced as an absolute ceiling.
export const MESHTASTIC_CHUNK_LIMIT = 200;
export const MESHTASTIC_HARD_LIMIT = 230;

/**
 * Split a reply into LoRa-sized chunks without breaking words or URLs.
 *
 * Reflows on whitespace, packing tokens up to the soft limit. A single token
 * longer than the soft limit (typically a URL) is kept whole up to the hard
 * frame limit so links stay valid — it's only hard-split as a last resort when
 * it cannot fit a single frame at all. The soft limit is clamped to the hard
 * frame limit, so an over-large `textChunkLimit` can never produce a chunk that
 * exceeds what one frame can carry.
 *
 * The previous implementation broke at a fixed offset when no nearby space was
 * found, which sliced long URLs in half and produced two unusable links.
 */
export function chunkText(text: string, limit: number): string[] {
  const trimmed = text.trim();
  // Clamp the soft limit to the physical frame size: callers may request a
  // smaller (stricter) limit, but never a larger one than a frame can carry.
  const softLimit = Math.max(1, Math.min(limit, MESHTASTIC_HARD_LIMIT));
  if (trimmed.length <= softLimit) {
    return trimmed ? [trimmed] : [];
  }

  // Greedily pack whitespace-separated tokens, never splitting a token.
  const packed: string[] = [];
  let cur = "";
  for (const word of trimmed.split(/\s+/)) {
    if (!word) continue;
    if (cur === "") {
      cur = word;
    } else if (cur.length + 1 + word.length <= softLimit) {
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
    if (entry.length <= MESHTASTIC_HARD_LIMIT) {
      chunks.push(entry);
      continue;
    }
    for (let i = 0; i < entry.length; i += MESHTASTIC_HARD_LIMIT) {
      chunks.push(entry.slice(i, i + MESHTASTIC_HARD_LIMIT));
    }
  }
  return chunks;
}
