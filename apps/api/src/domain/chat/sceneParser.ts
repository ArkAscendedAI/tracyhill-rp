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

// The streaming check's block pattern is ^-ANCHORED: checkStreamingBuffer
// only ever asks "is the block at the START of the response?" — an unanchored
// match found a block anywhere later in the buffer and withheld every delta
// before it from the live stream. parseSceneBlock keeps its own unanchored,
// position-aware passes below.
const SCENE_BLOCK_PATTERN = /^\[SCENE\]\s*\n([\s\S]*?)\n\s*\[\/SCENE\]\s*\n*/i;
const SCENE_INLINE_PATTERN = /^\[SCENE:\s[^\]]*\]\s*\n*/i;
const SCENE_XML_PATTERN = /^<scene_state>[^<]*<\/scene_state>\s*\n*/i;

// Inline/XML tags carry `KEY: value` chunks split on "|". Only these keys are
// field markers — any other "Word: rest" chunk is literal text (a location like
// "Earth: Harbor Town" used to become key EARTH and null the location).
const INLINE_SCENE_KEYS = new Set(["SCENE", "LOCATION", "PRESENT", "PRESENT_UNAWARE", "NOT PRESENT", "REASON", "DATE", "TIME", "ATTIRE"]);

// Model-emitted "nothing here" tokens for list fields. Only the exact
// lowercase "none" was recognised, so `present_unaware: None` became a roster
// character called None that every later scene_state carried as NOT PRESENT.
const NULL_LIST_TOKENS = new Set(["none", "nobody", "no one", "no-one", "n/a", "na", "nil", "null", "empty", "\u2014", "-", "--"]);
function splitNameList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed || NULL_LIST_TOKENS.has(trimmed.toLowerCase())) return [];
  // Deduplicated: "present: Mara, Mara" used to reach the roster twice.
  return [...new Set(splitOutsideParentheses(trimmed).map((s) => s.trim()).filter((s) => s && !NULL_LIST_TOKENS.has(s.toLowerCase())))];
}

// Commas inside a parenthetical note belong to the note (2026-09-29): "Vale (Cell 6, behind glass), Mara" is two
// people, not "Vale (Cell 6" and "behind glass)". A list whose parentheses do not balance, or nest (the name
// cleaners strip one level), splits on every comma, as before, so an odd note never swallows the names after it.
function splitOutsideParentheses(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") {
      if (++depth > 1) return text.split(",");
    } else if (ch === ")") {
      if (depth === 0) return text.split(",");
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return text.split(",");
  parts.push(text.slice(start));
  return parts;
}

function parseInlineScene(raw: string): SceneState | null {
  // Strip only the wrapper that belongs to THIS form: the `]` strip applied to
  // the XML form used to cut the tag at the first "]" inside a location.
  let inner = raw.trim();
  if (/^\[SCENE:/i.test(inner)) inner = inner.replace(/^\[SCENE:\s*/i, "").replace(/\]\s*$/, "");
  else inner = inner.replace(/^<scene_state>/i, "").replace(/<\/scene_state>\s*$/i, "");
  inner = inner.trim();
  const parts = inner.split("|").map(s => s.trim());
  const fields = new Map<string, string>();
  // Positional location: a bracket-inline tag like "[SCENE: The Library | PRESENT: Mara]"
  // carries the location as the text before the first "|" with no SCENE/LOCATION key.
  // Without this it parses to null and carry-forward silently reuses the stale scene.
  let positionalLocation: string | null = null;
  parts.forEach((p, i) => {
    const idx = p.indexOf(":");
    const key = idx > 0 ? p.slice(0, idx).trim().toUpperCase() : null;
    if (key && INLINE_SCENE_KEYS.has(key)) fields.set(key, p.slice(idx + 1).trim());
    else if (i === 0 && p) positionalLocation = p;
  });
  const location = fields.get("SCENE") ?? fields.get("LOCATION") ?? positionalLocation;
  const present = splitNameList(fields.get("PRESENT"));
  if (!location || !fields.has("PRESENT")) return null;
  const presentUnaware = splitNameList(fields.get("PRESENT_UNAWARE"));
  const reason = fields.get("REASON") ?? null;
  const date = fields.get("DATE") ?? null;
  const time = fields.get("TIME") ?? null;
  const attire = fields.has("ATTIRE") ? parseAttireEntries(fields.get("ATTIRE") ?? "") : null;
  return { location, present, presentUnaware, reason, date, time, attire };
}

function extractField(block: string, field: string): string | null {
  const regex = new RegExp(`^[ \\t]*${field}[ \\t]*:[ \\t]*([^\\r\\n]*)$`, "im");
  const match = block.match(regex);
  return match?.[1]?.trim() || null;
}

function extractListField(block: string, field: string): string[] {
  return splitNameList(extractField(block, field));
}

/**
 * Parse and strip ALL scene metadata from an assistant response, regardless of position.
 * Handles mid-message scene transitions (e.g. character walks from one location to another).
 * Returns clean narrative content with all metadata stripped and the last valid scene state.
 */
// Living World — strip any GM-spotlight markers the model MIMICS in its own
// output (it imitates scaffolding it sees in history). Without this, a fake
// `[GM SPOTLIGHT — …]` line would render as story prose. Applied to assistant
// output only (the real marker is a separate persisted user message).
export function stripSpotlightMarkers(content: string): string {
  return content.replace(/^[ \t]*\[GM SPOTLIGHT [—-][^\]]*\]\s*$/gim, "").replace(/\n{3,}/g, "\n\n");
}

export function parseSceneBlock(content: string): {
  cleanContent: string;
  sceneState: SceneState | null;
} {
  // "Last valid scene wins" must be resolved by POSITION in the original message,
  // not per-format-pass: an early <scene_state> echo followed by a later [SCENE]
  // block must persist the LATER scene. We collect every parsed match against its
  // index in the ORIGINAL content, then pick the one whose match starts latest.
  let cleaned = content;
  let bestScene: SceneState | null = null;
  let bestIndex = -1;
  const consider = (index: number, scene: SceneState | null) => {
    if (scene && index >= bestIndex) { bestScene = scene; bestIndex = index; }
  };

  // 1. Strip all [SCENE BREAK ...] markers globally (no scene state)
  cleaned = cleaned.replace(/\[SCENE BREAK[^\]]*\]\s*\n*/gi, "");

  // 2. [SCENE]...[/SCENE] blocks
  for (const m of content.matchAll(/\[SCENE\]\s*\n([\s\S]*?)\n\s*\[\/SCENE\]\s*\n*/gi)) {
    const block = m[1]!;
    const location = extractField(block, "location");
    const present = extractListField(block, "present");
    if (location && /^[ \t]*present[ \t]*:/im.test(block)) {
      consider(m.index!, { location, present, presentUnaware: extractListField(block, "present_unaware"), reason: extractField(block, "reason"), date: extractField(block, "date"), time: extractField(block, "time"), attire: extractAttireBlockField(block) });
    }
  }
  cleaned = cleaned.replace(/\[SCENE\]\s*\n([\s\S]*?)\n\s*\[\/SCENE\]\s*\n*/gi, "");

  // 3. [SCENE: ...] inline tags
  for (const m of content.matchAll(/\[SCENE:\s[^\]]*\]\s*\n*/gi)) {
    consider(m.index!, parseInlineScene(m[0]));
  }
  cleaned = cleaned.replace(/\[SCENE:\s[^\]]*\]\s*\n*/gi, "");

  // 4. <scene_state>...</scene_state> XML tags
  for (const m of content.matchAll(/<scene_state>[^<]*<\/scene_state>\s*\n*/gi)) {
    consider(m.index!, parseInlineScene(m[0]));
  }
  cleaned = cleaned.replace(/<scene_state>[^<]*<\/scene_state>\s*\n*/gi, "");

  // 5. Hybrid: <scene_state> opening with [/SCENE] closing (model mixes formats).
  // The body must not cross a </scene_state> (tempered lazy group): the
  // old `[\s\S]*?` let a proper XML tag followed LATER by a hybrid block match
  // from the FIRST tag's index — the same index pass 4 recorded — and the `>=`
  // tie handed the win to a garbage location spanning both tags.
  for (const m of content.matchAll(/<scene_state>((?:(?!<\/scene_state>)[\s\S])*?)\[\/SCENE\]\s*\n*/gi)) {
    const block = m[1]!.replace(/^\s*SCENE:\s*/, "location: ").trim();
    const location = extractField(block, "location");
    const present = extractListField(block, "present");
    if (location && /^[ \t]*present[ \t]*:/im.test(block)) {
      consider(m.index!, { location, present, presentUnaware: extractListField(block, "present_unaware"), reason: extractField(block, "reason"), date: extractField(block, "date"), time: extractField(block, "time"), attire: extractAttireBlockField(block) });
    }
  }
  cleaned = cleaned.replace(/<scene_state>((?:(?!<\/scene_state>)[\s\S])*?)\[\/SCENE\]\s*\n*/gi, "");

  return { cleanContent: cleaned.trim(), sceneState: bestScene };
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
// Date/time vocabulary that is implausible as a character name and is rejected
// even bare ("Monday"). Month names and "dawn" are deliberately NOT here — May
// Ryder, Dawn Hale, a character called June are plausible cast names. Their
// compound date forms ("June 11", "May, 2024") die anyway: digits are rejected
// outright and a comma is not legal name punctuation, so no month list is
// needed (an earlier version carried one behind a lookahead that could only
// fire on a digit or a comma — both already rejected — i.e. dead code).
const NEVER_NAME_WORDS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "today", "tomorrow", "yesterday", "morning", "afternoon", "evening", "night", "midnight", "noon", "dusk",
]);

/** Shared source-of-truth for scene-derived character names. The scene block is
 * model-authored, so date/time fragments and null tokens must never become
 * roster rows or drive sheets. Apostrophes and hyphens remain legal name
 * punctuation; a typographic apostrophe (U+2019, the one most models emit in
 * prose) folds to ASCII so "T’Vara" and "T'Vara" are one character, an
 * internal period is an abbreviation ("Dr. Ash") and a trailing one is
 * list punctuation ("present: Mara, Ryn."). Before this rule,
 * "T’Vara", "O’Brien" and "Dr. Ash" were silently dropped from the roster
 * and never got a drive sheet while still appearing raw in PRESENT.
 *
 * Rejection rules, biased to never break a real character name: any digits,
 * a date:/time: prefix, a bare never-name word ("Monday"), a null-list token
 * ("None", "Nobody"), or punctuation outside letters/marks/'/-/space (which is
 * what kills "May, 2024"). Date-word-LED names always pass — "May Ryder",
 * "Dawn Hale", and a bare "May"/"Dawn"/"June" are plausible cast names (an
 * earlier prefix-based version of this check silently broke their automation,
 * which is a worse failure than a rare cosmetic "Tuesday" roster row would be). */
export function sanitizeCharacterName(raw: string): string | null {
  // Strip parenthetical modifiers: "Ryn (dead)" → "Ryn"; fold typographic
  // apostrophes; drop trailing periods.
  const cleaned = raw.replace(/\s*\([^)]*\)\s*/g, "").replace(/[\u2018\u2019]/g, "'").trim().replace(/\.+$/, "").trim();
  if (!cleaned || cleaned.length > 100) return null;
  const lower = cleaned.toLocaleLowerCase();
  if (/^(?:date|time)\s*:/i.test(cleaned)) return null;
  if (/\d/.test(cleaned)) return null;
  if (NEVER_NAME_WORDS.has(lower)) return null;
  if (NULL_LIST_TOKENS.has(lower)) return null;
  if (!/^[\p{L}][\p{L}\p{M}'.\- ]*$/u.test(cleaned)) return null;
  // Reject group descriptions: must start with a capital letter (proper noun)
  if (!/^\p{Lu}/u.test(cleaned)) return null;
  return cleaned;
}

/**
 * The present lists as CHARACTER NAMES, for every comparison and lookup:
 * parenthetical annotations stripped the way the roster
 * strips them, blanks dropped, duplicates dropped. An entry that is not a name
 * ("two guards") is kept verbatim so a lookup never silently loses an entry.
 * `sessions.scene_present` and `scene_data.present` keep the model's raw
 * strings (the scene chip and the PRESENT line show what it wrote) while the
 * roster stores the sanitized name; comparing raw against sanitized put "Ryn
 * (unconscious)" in PRESENT and "Ryn" in NOT PRESENT at once and made the
 * attire, agenda, brief, absent-contact, offscreen-memory and fuse lookups
 * miss the character for the turn.
 */
export function normalizePresentNames(names: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const name = sanitizeCharacterName(text) ?? text;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Update a campaign's character roster by adding any new characters from a scene state.
 * Names are sanitized: parenthetical annotations stripped, group descriptions rejected.
 * Returns the updated roster (or null if no changes). Deduplicated on both sides:
 * the new names against each other, and a stored roster that already
 * carries a duplicate (written before the fix) is repaired in the same write.
 */
export function updateCharacterRoster(currentRoster: string[], sceneState: SceneState): string[] | null {
  const roster = [...new Set(currentRoster)];
  const seen = new Set(roster);
  const newCharacters: string[] = [];
  for (const raw of [...sceneState.present, ...sceneState.presentUnaware]) {
    const name = sanitizeCharacterName(raw);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    newCharacters.push(name);
  }
  if (!newCharacters.length && roster.length === currentRoster.length) return null;
  return [...roster, ...newCharacters];
}

/**
 * Compute the NOT PRESENT list from a roster and a scene state. Compares
 * sanitized names, case-insensitively: a roster entry is absent only
 * when no present entry names it. Never lists a name twice.
 */
export function computeNotPresent(roster: string[], sceneState: SceneState): string[] {
  const presentKeys = new Set(normalizePresentNames([...sceneState.present, ...sceneState.presentUnaware]).map((n) => n.toLocaleLowerCase()));
  const seen = new Set<string>();
  return roster.filter((c) => {
    const key = c.toLocaleLowerCase();
    if (presentKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

## CHARACTER KNOWLEDGE ENFORCEMENT: Mandatory, every turn

Before writing dialogue, reactions, or inner thoughts for ANY character:

1. **Check the Retrieved Context sections.** Entries under "Scene Knowledge" are available to all present characters. Entries under "Narrator-Only Knowledge" are tagged with KNOWN BY and NOT KNOWN BY PRESENT. If the character you are writing is in the NOT KNOWN BY list, they CANNOT reference, react to, imply awareness of, or act on that information.
2. **Was this character physically present** when the information was revealed? Check the [SCENE] and scene_state tags for the scene where it happened.
3. **Was this character directly told** this information on-screen in a prior scene where both parties were present?
4. **If neither, the character DOES NOT KNOW IT.** No exceptions.

Narrator-Only Knowledge exists so YOU can write the scene accurately: a character who IS from another dimension should ACT like it, even if other characters don't KNOW it. Unknowing characters must not reference, deduce, or react to information they haven't witnessed or been told.

**Private conversations are private.** Same building, same faction, same friendship circle does NOT grant shared knowledge. [SCENE BREAK] markers in the message history indicate location changes. Information from prior scenes does not carry to characters who were not there.

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

## SCENE STATE TRACKING: Infrastructure (do not reference in narrative)

Before your narrative response on every turn, emit a [SCENE] block reporting the current scene state. This is infrastructure metadata. The system strips it before display. Do not reference it in your prose.

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
reason: {what changed: who arrived, who left, who lost consciousness, or the location changed}
[/SCENE]

Rules:
- Emit this block at the very start of every response, before any narrative text.
- Only list characters who are physically in the scene. "In the same city" is not "present."
- Use clean character names only, with no annotations: write "Pico" rather than "Pico (dead)", and for "Aldric (unconscious)" move the name to present_unaware instead. No group descriptions such as "two vault security personnel" or "several guards"; list named individuals only.
- When a new character enters mid-scene, add them to present with a reason.
- When a character leaves or departs, remove them with a reason.
- If a character dies, remove them from present with a reason. Dead characters do not appear in any field.
- If a character loses consciousness, move them from present to present_unaware with a reason.
- For date/time: emit them as natural free-form strings ("Monday, September 28, 1998", "10:47 AM", "late evening", whatever fits the narrative voice), but the date must be a calendar date: month, day and, once the story has established it, the year. Never put relative time in the date field. "Two days later", "the next morning" or "Saturday night" belong in the narrative; advance the calendar date instead. Both fields are optional. If you genuinely don't know the in-world date or time, omit the field rather than guessing.
- Keep date/time consistent with the narrative: if the prose says "morning," the scene is not tagged "11 PM."
- **Optional ATTIRE field** (advisory only; a server-side auditor reconciles the authoritative state from your narrative regardless):
  When attire changes within the turn for any present character, you MAY emit an attire line listing the new state for the characters whose clothing changed. Format: \`attire: Cob=stripped to bare chest; Ragen=blacksmith apron over linen shirt\`, with a semicolon between characters and an equals sign between name and outfit prose. Include damage/soiling as part of the prose (e.g., "bloodied tunic"). Omit this field entirely when nothing changed. The auditor reads your prose either way.
- The [SCENE] block is infrastructure. Never write "[SCENE]" or reference scene tracking in your narrative prose.
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

  // The ^-anchored SCENE patterns must run against the TRIMMED buffer: when the
  // response starts with leading whitespace, matching the untrimmed buffer fails,
  // so nothing streams until the >2000-char give-up flushes a raw tag. Always
  // operate on `trimmed` here; breakOffset re-aligns endIndex back to `buffer`.
  const leadingWs = buffer.length - trimmed.length;
  // Strip leading [SCENE BREAK ...] markers before checking for scene blocks
  const sceneBreakStripped = trimmed.replace(/^\[SCENE BREAK[^\]]*\]\s*\n*/gi, "");
  const effectiveBuffer = sceneBreakStripped;
  const breakOffset = leadingWs + (trimmed.length - effectiveBuffer.length);

  // Look for the closing tag (anchored: the block must START the response)
  const match = effectiveBuffer.match(SCENE_BLOCK_PATTERN);
  if (match) {
    return { status: "complete", endIndex: breakOffset + match.index! + match[0].length };
  }

  // A [SCENE BREAK …] marker followed by prose: the marker was the only leading
  // metadata, so stream from just past it instead of withholding the prose while
  // an unanchored search hunted for a block further down. A block the
  // model emits later mid-message is handled like any mid-message block — it is
  // stripped from the persisted message by parseSceneBlock.
  if (breakOffset > leadingWs && effectiveBuffer.length >= 14 && !/^(\[SCENE|<scene_state>)/i.test(effectiveBuffer)) {
    return { status: "complete", endIndex: breakOffset };
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
