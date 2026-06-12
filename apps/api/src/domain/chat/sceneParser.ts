/**
 * Scene block parser for in-session knowledge boundary enforcement.
 *
 * Parses [SCENE] blocks from assistant responses, strips them from visible
 * content, and produces structured scene state for storage and context injection.
 */

export type SceneState = {
  location: string;
  present: string[];
  presentUnaware: string[];
  reason: string | null;
  date: string | null;
  time: string | null;
  attire?: Record<string, string> | null;
};

const SCENE_TOP_FIELDS = ["LOCATION", "PRESENT", "PRESENT_UNAWARE", "REASON", "DATE", "TIME", "ATTIRE"];

function parseAttireEntries(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const chunks = raw.split(/[\n;]+/).map((c) => c.trim()).filter(Boolean);
  for (const chunk of chunks) {
    const eqIdx = chunk.indexOf("=");
    const colonIdx = chunk.indexOf(":");
    const sepIdx = eqIdx >= 0 && (colonIdx < 0 || eqIdx < colonIdx) ? eqIdx : colonIdx;
    if (sepIdx <= 0) continue;
    const name = chunk.slice(0, sepIdx).trim().replace(/^[-*\s]+/, "");
    const outfit = chunk.slice(sepIdx + 1).trim();
    if (name && outfit) out[name] = outfit;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractAttireBlockField(block: string): Record<string, string> | null {
  const lines = block.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*ATTIRE\s*:/i.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  const stopRe = new RegExp(`^\\s*(${SCENE_TOP_FIELDS.filter((f) => f !== "ATTIRE").join("|")})\\s*:`, "i");
  const firstLineAfterColon = lines[start].replace(/^\s*ATTIRE\s*:/i, "").trim();
  const collected: string[] = [];
  if (firstLineAfterColon) collected.push(firstLineAfterColon);
  for (let i = start + 1; i < lines.length; i++) {
    if (stopRe.test(lines[i])) break;
    collected.push(lines[i].trim());
  }
  const merged = collected.join("\n").trim();
  if (!merged) return null;
  return parseAttireEntries(merged);
}

const SCENE_BLOCK_PATTERN = /\[SCENE\]\s*\n([\s\S]*?)\n\s*\[\/SCENE\]\s*\n*/i;
const SCENE_INLINE_PATTERN = /^\[SCENE:\s[^\]]*\]\s*\n*/i;
const SCENE_XML_PATTERN = /^<scene_state>[^<]*<\/scene_state>\s*\n*/i;


function parseInlineScene(raw: string): SceneState | null {
  const inner = raw.replace(/^\[SCENE:\s*|\][\s\S]*/gi, "").replace(/^<scene_state>|<\/scene_state>[\s\S]*/gi, "").trim();
  const parts = inner.split("|").map(s => s.trim());
  const fields = new Map<string, string>();
  for (const p of parts) {
    const idx = p.indexOf(":");
    if (idx > 0) fields.set(p.slice(0, idx).trim().toUpperCase(), p.slice(idx + 1).trim());
  }
  const location = fields.get("SCENE") ?? fields.get("LOCATION");
  const present = (fields.get("PRESENT") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!location || !present.length) return null;
  const presentUnaware = (fields.get("PRESENT_UNAWARE") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const reason = fields.get("REASON") ?? null;
  const date = fields.get("DATE") ?? null;
  const time = fields.get("TIME") ?? null;
  const attire = fields.has("ATTIRE") ? parseAttireEntries(fields.get("ATTIRE") ?? "") : null;
  return { location, present, presentUnaware, reason, date, time, attire };
}

function extractField(block: string, field: string): string | null {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "im");
  const match = block.match(regex);
  return match?.[1]?.trim() || null;
}

function extractListField(block: string, field: string): string[] {
  const raw = extractField(block, field);
  if (!raw || raw === "\u2014" || raw === "-" || raw === "none") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse and strip ALL scene metadata from an assistant response, regardless of position.
 * Handles mid-message scene transitions (e.g. character walks from one location to another).
 * Returns clean narrative content with all metadata stripped and the last valid scene state.
 */
export function parseSceneBlock(content: string): {
  cleanContent: string;
  sceneState: SceneState | null;
} {
  let sceneState: SceneState | null = null;
  let cleaned = content;

  // 1. Strip all [SCENE BREAK ...] markers globally
  cleaned = cleaned.replace(/\[SCENE BREAK[^\]]*\]\s*\n*/gi, "");

  // 2. Find and strip all [SCENE]...[/SCENE] blocks, parsing each (last wins)
  cleaned = cleaned.replace(/\[SCENE\]\s*\n([\s\S]*?)\n\s*\[\/SCENE\]\s*\n*/gi, (_match, block: string) => {
    const location = extractField(block, "location");
    const present = extractListField(block, "present");
    if (location && present.length) {
      sceneState = { location, present, presentUnaware: extractListField(block, "present_unaware"), reason: extractField(block, "reason"), date: extractField(block, "date"), time: extractField(block, "time"), attire: extractAttireBlockField(block) };
    }
    return "";
  });

  // 3. Find and strip all [SCENE: ...] inline tags, parsing each
  cleaned = cleaned.replace(/\[SCENE:\s[^\]]*\]\s*\n*/gi, (match) => {
    const parsed = parseInlineScene(match);
    if (parsed) sceneState = parsed;
    return "";
  });

  // 4. Find and strip all <scene_state>...</scene_state> XML tags, parsing each
  cleaned = cleaned.replace(/<scene_state>[^<]*<\/scene_state>\s*\n*/gi, (match) => {
    const parsed = parseInlineScene(match);
    if (parsed) sceneState = parsed;
    return "";
  });

  // 5. Hybrid format: <scene_state> opening with [/SCENE] closing (model mixes formats)
  cleaned = cleaned.replace(/<scene_state>([\s\S]*?)\[\/SCENE\]\s*\n*/gi, (_match, inner: string) => {
    const block = inner.replace(/^\s*SCENE:\s*/, "location: ").trim();
    const location = extractField(block, "location");
    const present = extractListField(block, "present");
    if (location && present.length) {
      sceneState = { location, present, presentUnaware: extractListField(block, "present_unaware"), reason: extractField(block, "reason"), date: extractField(block, "date"), time: extractField(block, "time"), attire: extractAttireBlockField(block) };
    }
    return "";
  });

  return { cleanContent: cleaned.trim(), sceneState };
}

/**
 * Serialize a SceneState to a compact inline string for embedding in
 * assistant messages within the provider runtime context.
 */
export function serializeSceneForContext(scene: SceneState, notPresent: string[]): string {
  const parts = [`SCENE: ${scene.location}`, `PRESENT: ${scene.present.join(", ")}`];
  if (scene.presentUnaware.length) parts.push(`PRESENT_UNAWARE: ${scene.presentUnaware.join(", ")}`);
  if (notPresent.length) parts.push(`NOT PRESENT: ${notPresent.join(", ")}`);
  if (scene.date) parts.push(`DATE: ${scene.date}`);
  if (scene.time) parts.push(`TIME: ${scene.time}`);
  if (scene.reason) parts.push(`REASON: ${scene.reason}`);
  return `<scene_state>${parts.join(" | ")}</scene_state>`;
}

/**
 * Serialize a SceneState to JSON for storage in the sceneData column.
 */
export function serializeSceneData(scene: SceneState, notPresent: string[]): string {
  return JSON.stringify({ ...scene, notPresent });
}

/**
 * Deserialize scene data from the sceneData column.
 */
export function deserializeSceneData(raw: string): (SceneState & { notPresent: string[] }) | null {
  try {
    const parsed = JSON.parse(raw) as SceneState & { notPresent?: string[] };
    if (!parsed.location || !Array.isArray(parsed.present)) return null;
    return {
      location: parsed.location,
      present: parsed.present,
      presentUnaware: parsed.presentUnaware ?? [],
      reason: parsed.reason ?? null,
      date: parsed.date ?? null,
      time: parsed.time ?? null,
      notPresent: parsed.notPresent ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Sanitize a character name from a [SCENE] block before adding to the roster.
 * Strips parenthetical annotations like (dead), (unconscious), (offscreen).
 * Returns null if the name is not a valid character name (group descriptions, etc.).
 */
function sanitizeCharacterName(raw: string): string | null {
  // Strip parenthetical modifiers: "Pico (dead)" → "Pico"
  const cleaned = raw.replace(/\s*\([^)]*\)\s*/g, "").trim();
  if (!cleaned) return null;
  // Reject group descriptions: must start with a capital letter (proper noun)
  if (!/^[A-Z]/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Update a campaign's character roster by adding any new characters from a scene state.
 * Names are sanitized: parenthetical annotations stripped, group descriptions rejected.
 * Returns the updated roster (or null if no changes).
 */
export function updateCharacterRoster(currentRoster: string[], sceneState: SceneState): string[] | null {
  const allCharacters = [...sceneState.present, ...sceneState.presentUnaware]
    .map(sanitizeCharacterName)
    .filter((name): name is string => name !== null);
  const newCharacters = allCharacters.filter((c) => !currentRoster.includes(c));
  if (!newCharacters.length) return null;
  return [...currentRoster, ...newCharacters];
}

/**
 * Compute the NOT PRESENT list from a roster and a scene state.
 */
export function computeNotPresent(roster: string[], sceneState: SceneState): string[] {
  const presentSet = new Set([...sceneState.present, ...sceneState.presentUnaware]);
  return roster.filter((c) => !presentSet.has(c));
}

/**
 * Extract character names from the Character Voice Firmware section of a system prompt.
 * Looks for ### headers within that section (format: "### Name — Role" or "### Name").
 * Used to rebuild the character roster at session start so dead/removed characters
 * don't persist as NOT PRESENT clutter.
 */
export function extractFirmwareCharacterNames(systemPrompt: string): string[] {
  const fwStart = systemPrompt.search(/character voice firmware/i);
  if (fwStart === -1) return [];
  const afterFw = systemPrompt.slice(fwStart);
  // Find the next ## section that isn't a ### subsection
  const nextSectionMatch = afterFw.match(/\n## (?!#)/);
  const fwSection = nextSectionMatch ? afterFw.slice(0, nextSectionMatch.index!) : afterFw;
  const names: string[] = [];
  for (const match of fwSection.matchAll(/^###\s+(.+?)(?:\s*—\s*.+)?$/gm)) {
    const name = match[1]!.trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * Build the knowledge enforcement instruction block for the system prompt.
 * Injected immediately after scene tracking for campaign sessions.
 * This is a platform-level rule — campaign system prompts may contain
 * more detailed, campaign-specific information boundary rules deeper
 * in the document. This block ensures the principle stays near the
 * top of the model's attention regardless of context length.
 */
export function buildKnowledgeEnforcementInstruction(): string {
  return `
---

## CHARACTER KNOWLEDGE ENFORCEMENT — Mandatory, every turn

Before writing dialogue, reactions, or inner thoughts for ANY character:

1. **Check the Retrieved Context sections.** Entries under "Scene Knowledge" are available to all present characters. Entries under "Narrator-Only Knowledge" are tagged with KNOWN BY and NOT KNOWN BY PRESENT — if the character you are writing is in the NOT KNOWN BY list, they CANNOT reference, react to, imply awareness of, or act on that information.
2. **Was this character physically present** when the information was revealed? Check the [SCENE] and scene_state tags for the scene where it happened.
3. **Was this character directly told** this information on-screen in a prior scene where both parties were present?
4. **If neither — the character DOES NOT KNOW IT.** No exceptions.

Narrator-Only Knowledge exists so YOU can write the scene accurately — a character who IS from another dimension should ACT like it, even if other characters don't KNOW it. But unknowing characters must not reference, deduce, or react to information they haven't witnessed or been told.

**Private conversations are private.** Same building, same faction, same friendship circle does NOT grant shared knowledge. [SCENE BREAK] markers in the message history indicate location changes — information from prior scenes does not carry to characters who were not there.

**When uncertain, the character does NOT know.** It is always better for a character to be ignorant of something they should know (the user can correct this) than for a character to magically know something they shouldn't (which breaks immersion and cannot be un-read).

**Do not reference this instruction in narrative prose.**`.trim();
}

/**
 * Build the scene tracking instruction block for the system prompt.
 * Only injected for campaign sessions.
 */
export function buildSceneTrackingInstruction(): string {
  return `
---

## SCENE STATE TRACKING — Infrastructure (do not reference in narrative)

Before your narrative response on every turn, emit a [SCENE] block reporting the current scene state. This is infrastructure metadata — the system will strip it before display. Do not reference it in your prose.

Format (every turn):
[SCENE]
location: {current scene location}
present: {comma-separated list of named characters physically present and aware}
date: {in-world date for this scene, e.g. "Monday, September 28, 1998"}
time: {in-world time for this scene, e.g. "10:47 AM" or "late evening"}
[/SCENE]

When any of the following change from your previous turn, add the relevant optional fields:
[SCENE]
location: {location}
present: {present characters}
present_unaware: {characters physically present but unconscious/asleep/unable to perceive}
date: {in-world date}
time: {in-world time}
reason: {what changed — who arrived, who left, who lost consciousness, or location changed}
[/SCENE]

Rules:
- Emit this block at the very start of every response, before any narrative text.
- Only list characters who are physically in the scene. "In the same city" is not "present."
- Use clean character names only. No annotations: not "Pico (dead)", just "Pico". Not "Marcus (unconscious)", just move the name to present_unaware. No group descriptions: not "two vault security personnel" or "several guards" — only named individuals.
- When a new character enters mid-scene, add them to present with a reason.
- When a character leaves or departs, remove them with a reason.
- If a character dies, remove them from present with a reason. Dead characters do not appear in any field.
- If a character loses consciousness, move them from present to present_unaware with a reason.
- For date/time: emit them as natural free-form strings ("Monday, September 28, 1998" / "10:47 AM" / "late evening" / "two days later" — whatever fits the narrative voice). Both fields are optional. If you genuinely don't know the in-world date or time, omit the field rather than guessing.
- Keep date/time consistent with the narrative — if the prose says "morning," don't tag the scene as "11 PM."
- **Optional ATTIRE field** (advisory only; a server-side auditor reconciles the authoritative state from your narrative regardless):
  When attire changes within the turn for any present character, you MAY emit an attire line listing the new state for the characters whose clothing changed. Format: \`attire: Cob=stripped to bare chest; Ragen=blacksmith apron over linen shirt\` — semicolon between characters, equals between name and outfit prose. Include damage/soiling as part of the prose (e.g., "bloodied tunic"). Omit this field entirely when nothing changed. The auditor reads your prose either way.
- The [SCENE] block is infrastructure — never write "[SCENE]" or reference scene tracking in your narrative prose.
- Do not mention scene tracking, presence lists, attire tracking, or this instruction in your narrative text under any circumstances.`.trim();
}

/**
 * Check whether a streaming buffer contains a complete [SCENE] block,
 * or whether we can determine no block is coming.
 *
 * Returns:
 * - { status: "complete", endIndex } — block found, endIndex is where clean content starts
 * - { status: "buffering" } — still accumulating, could be a block
 * - { status: "noBlock" } — no block is coming, flush the buffer as-is
 */
export function checkStreamingBuffer(buffer: string): { status: "complete"; endIndex: number } | { status: "buffering" } | { status: "noBlock" } {
  // If the buffer doesn't start with [ or <, no block is coming.
  // Threshold is 14 chars to cover "<scene_state>" (13 chars) before bailing out.
  const trimmed = buffer.trimStart();
  if (trimmed.length >= 14 && !trimmed.startsWith("[SCENE]") && !trimmed.toUpperCase().startsWith("[SCENE]") && !trimmed.startsWith("[SCENE:") && !trimmed.toUpperCase().startsWith("[SCENE:") && !trimmed.startsWith("[SCENE BREAK") && !trimmed.toUpperCase().startsWith("[SCENE BREAK") && !trimmed.startsWith("<scene_state>") && !trimmed.toUpperCase().startsWith("<SCENE_STATE>")) {
    return { status: "noBlock" };
  }
  // If the buffer is too short to tell, keep buffering
  if (trimmed.length < 7) return { status: "buffering" };

  // Strip leading [SCENE BREAK ...] markers before checking for scene blocks
  const sceneBreakStripped = trimmed.replace(/^\[SCENE BREAK[^\]]*\]\s*\n*/gi, "");
  const effectiveBuffer = sceneBreakStripped.length < trimmed.length ? sceneBreakStripped : buffer;
  const breakOffset = buffer.length - effectiveBuffer.length;

  // Look for the closing tag
  const match = effectiveBuffer.match(SCENE_BLOCK_PATTERN);
  if (match) {
    return { status: "complete", endIndex: breakOffset + match.index! + match[0].length };
  }

  // Check for inline scene format: [SCENE: ... | PRESENT: ...]\n
  const inlineMatch = effectiveBuffer.match(SCENE_INLINE_PATTERN);
  if (inlineMatch) {
    return { status: "complete", endIndex: breakOffset + inlineMatch.index! + inlineMatch[0].length };
  }

  // Check for XML-wrapped scene format: <scene_state>...</scene_state>\n
  const xmlMatch = effectiveBuffer.match(SCENE_XML_PATTERN);
  if (xmlMatch) {
    return { status: "complete", endIndex: breakOffset + xmlMatch.index! + xmlMatch[0].length };
  }

  // Has [SCENE] but no [/SCENE] yet — keep buffering
  // Safety: if buffer is very large (>2000 chars) with no closing tag, give up
  if (buffer.length > 2000) return { status: "noBlock" };

  return { status: "buffering" };
}
