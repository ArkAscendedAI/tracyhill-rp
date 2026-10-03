import { createLorebookEntryRequestSchema, lorebookPositionSchema, type LorebookPosition } from "./lorebook";

// The marker line the generation prompt asks for is `PLAYER_CHARACTER: <name>`.
// Models routinely emit it decorated — `**PLAYER_CHARACTER:** Corin`,
// `**PLAYER_CHARACTER**: Corin`, a backticked or `#`-prefixed form — and the
// literal startsWith test fell back to the placeholder for every such run, so
// approval seeded no player key and the named authority lint never had a name.
// The regex reads the name through leading/trailing
// emphasis and a colon on either side of the closing emphasis.
const PLAYER_CHARACTER_MARKER_LINE = /^[\s*_`>#-]*PLAYER_CHARACTER[\s*_`]*:[\s*_`]*(.*?)[\s*_`]*$/i;
export const WIZARD_PLAYER_CHARACTER_FALLBACK = "the player character";

/** The name text of a `PLAYER_CHARACTER:` marker line (possibly empty), or null for any other line. */
function readPlayerCharacterMarker(line: string): string | null {
  const match = PLAYER_CHARACTER_MARKER_LINE.exec(line);
  return match ? match[1]! : null;
}
export const CANONICAL_PC_PROTECTION_HEADING = "## Section A: Player Character Authority (CANONICAL)";

/**
 * Single source for the player/world authorship boundary stamped into every
 * wizard-generated system prompt. The wizard model never authors or rewrites
 * this block; the placeholder is the only substituted text.
 */
const CANONICAL_PC_PROTECTION_BLOCK = `${CANONICAL_PC_PROTECTION_HEADING}

{{PLAYER_CHARACTER_SUBJECT}} is the player character. The player alone authors {{PLAYER_CHARACTER_POSSESSIVE}} voluntary dialogue, inner thoughts, decisions, choices, consent, and intentional actions. Never write, imply, summarize, or presuppose any of them.

The model owns every NPC, the environment, and world-time. NPCs and the world act, react, interrupt, escalate, and impose grounded involuntary physical or sensory consequences without waiting for {{PLAYER_CHARACTER}} to act.

When a scene reaches a genuine decision or intentional-action point for {{PLAYER_CHARACTER}}, carry the world through the consequence or event already in motion, stop at that decision point, and return the floor. Do not turn an active event into an offer, permission request, or passive question.

NPCs may pressure, restrain, injure, surprise, deceive, or otherwise affect {{PLAYER_CHARACTER}} when grounded in canon. Never presuppose {{PLAYER_CHARACTER_POSSESSIVE}} voluntary response, consent, failure, or inner state.`;

export type WizardLintScope = "system_prompt" | "corpus";

// Bare function/calendar words as retrieval keys fire on virtually every turn,
// silently turning an entry into an accidental constant (a "Date & Time
// Tracking" board once injected on every turn via keys like "when"/"today"
// and fed stale state into the story). Deterministic
// trim — no LLM needed.
const BROAD_RETRIEVAL_KEYS = new Set([
  "when", "today", "tomorrow", "yesterday", "now", "time", "day", "date", "here", "there",
  "what", "who", "where", "why", "how", "schedule", "then", "soon", "later", "current",
  "the", "a", "an", "it", "this", "that",
]);

export function splitBroadRetrievalKeys(keys: string[] | undefined): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const key of keys ?? []) {
    const normalized = key.trim();
    if (!normalized) continue;
    (BROAD_RETRIEVAL_KEYS.has(normalized.toLocaleLowerCase()) ? dropped : kept).push(normalized);
  }
  return { kept, dropped };
}

/** One spelling per corpus entry name: approval keys attire/drive seeds and
 *  scheme targets by name, so "Veyra" and "veyra " must be the same entry. */
export function normalizeWizardCorpusName(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export type WizardCorpusRetrievalFields = {
  position: LorebookPosition;
  scanDepth: number;
  insertionOrder: number;
  /** Human-readable notes for every field that was replaced by its default. */
  corrections: string[];
};

/**
 * The wizard corpus contract keeps `position`/`scanDepth`/`insertionOrder`
 * loose (a frozen run must still parse), so the writers validate them HERE
 * through the lorebook HTTP contract's own field schemas: an out-of-enum
 * position ("middle") used to be stored and then rejected on every later
 * save of the entry, and `scanDepth: 500` made an entry scan the whole
 * session every turn. A field the contract refuses
 * falls back to the same default the HTTP path applies, and says so.
 */
export function normalizeCorpusRetrievalFields(entry: { position?: string; scanDepth?: number; insertionOrder?: number }): WizardCorpusRetrievalFields {
  const corrections: string[] = [];
  const position = createLorebookEntryRequestSchema.shape.position.safeParse(entry.position);
  const scanDepth = createLorebookEntryRequestSchema.shape.scanDepth.safeParse(entry.scanDepth);
  const insertionOrder = createLorebookEntryRequestSchema.shape.insertionOrder.safeParse(entry.insertionOrder);
  const defaults = createLorebookEntryRequestSchema.pick({ position: true, scanDepth: true, insertionOrder: true }).parse({});
  if (!position.success) corrections.push(`position ${JSON.stringify(String(entry.position).slice(0, 40))} is not one of ${lorebookPositionSchema.options.join("/")} — using ${defaults.position}`);
  if (!scanDepth.success) corrections.push(`scanDepth ${JSON.stringify(entry.scanDepth)} is not an integer between 0 and 100 — using ${defaults.scanDepth}`);
  if (!insertionOrder.success) corrections.push(`insertionOrder ${JSON.stringify(entry.insertionOrder)} is not an integer between 0 and 10000 — using ${defaults.insertionOrder}`);
  return {
    position: position.success ? position.data : defaults.position,
    scanDepth: scanDepth.success ? scanDepth.data : defaults.scanDepth,
    insertionOrder: insertionOrder.success ? insertionOrder.data : defaults.insertionOrder,
    corrections,
  };
}

export type WizardFirmwareLintFinding = {
  code: string;
  scope: WizardLintScope;
  location: string;
  message: string;
  excerpt: string;
  line: number | null;
};

// Prohibition shapes the two duplicate_pc_authority patterns share. Until
// 2026-09-23 the list was never/must not/do not/cannot/can't, so "will not
// write", "does not write", "won't narrate", "shall not", "may not" and "is not
// to" all passed — the shipped exemplar's own "The model does not write Alex's
// internal state, ever." lint-clean. Modal/present prohibitions only:
// narrative past ("did not decide for Corin") stays out on purpose.
const AUTHORITY_NEGATION = String.raw`(?:never|must\s+not|mustn't|do\s+not|don't|does\s+not|doesn't|will\s+not|won't|shall\s+not|shan't|should\s+not|shouldn't|may\s+not|cannot|can\s+not|can't|is\s+not\s+to|are\s+not\s+to)`;
// "speak for" and "act for", and the joined forms SillyTavern lorebooks use for the same rule: "speak or act for",
// "act, speak, or think for", "speak and act on behalf of" (SillyTavern import, 2026-10-02). "act as" stays out:
// "guards do not act as escorts for the player" is a world fact.
const AUTHORITY_ACT = String.raw`(?:speak|act|think|talk|reply|respond|decide|feel)`;
const AUTHORITY_VERB = String.raw`(?:write|author|supply|decide|control|narrate|${AUTHORITY_ACT}(?:\s*,\s*${AUTHORITY_ACT})*(?:,?\s+(?:or|and|nor)\s+${AUTHORITY_ACT})?\s+(?:for|on\s+behalf\s+of))`;

const interactionPatterns: Array<{ code: string; message: string; pattern: RegExp }> = [
  {
    code: "floor_yielding_absolute",
    message: "Generated text makes world action wait on the player.",
    pattern: /\b(?:wait|waits|waiting|await|awaits|awaiting)\s+(?:for\s+)?(?:the\s+)?(?:player|user|player character)\b|\b(?:until|unless)\s+(?:the\s+)?(?:player|user|player character)\s+(?:acts?|responds?|chooses?|decides?|speaks?)\b/i,
  },
  {
    code: "world_passivity",
    message: "Generated text requires the world or NPCs to become passive.",
    pattern: /\b(?:the\s+)?world\s+(?:must\s+|should\s+)?(?:pause|pauses|wait|waits|stop|stops|remain passive|hold still)\b|\bNPCs?\s+(?:must\s+|should\s+)?(?:never act|wait|remain passive|hold still)\b/i,
  },
  {
    code: "reply_shape_conflict",
    message: "Generated text mandates a reply ending that can interrupt world-time authority.",
    pattern: /\b(?:every|each)\s+(?:response|reply)\s+(?:must|should|will)\s+(?:end|close|stop)\b|\b(?:always|must)\s+(?:end|close)\s+(?:every|each|the)\s+(?:response|reply)\b/i,
  },
  {
    code: "duplicate_pc_authority",
    message: "Player-authority mechanics appear outside the canonical block.",
    pattern: new RegExp(String.raw`\b${AUTHORITY_NEGATION}\s+${AUTHORITY_VERB}[^.\n]{0,140}\b(?:player|user|player character)\b`, "i"),
  },
  {
    code: "permission_loop",
    message: "Generated text turns active world events into permission requests.",
    pattern: /\b(?:always|must|should)\s+(?:ask|offer|request)\s+(?:the\s+)?(?:player|user|player character)[^.\n]{0,100}\b(?:permission|choice|response|action)\b/i,
  },
];

function normalizeWizardPlayerCharacterName(value: string | null | undefined): string {
  const normalized = value?.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  return normalized || WIZARD_PLAYER_CHARACTER_FALLBACK;
}

export function buildCanonicalPcProtectionBlock(playerCharacterName: string | null | undefined): string {
  const name = normalizeWizardPlayerCharacterName(playerCharacterName);
  const displayName = name === WIZARD_PLAYER_CHARACTER_FALLBACK ? WIZARD_PLAYER_CHARACTER_FALLBACK : name;
  const subject = name === WIZARD_PLAYER_CHARACTER_FALLBACK ? "The player character" : name;
  const possessive = `${displayName}${displayName.toLowerCase().endsWith("s") ? "'" : "'s"}`;
  return CANONICAL_PC_PROTECTION_BLOCK
    .replaceAll("{{PLAYER_CHARACTER_SUBJECT}}", () => subject)
    .replaceAll("{{PLAYER_CHARACTER_POSSESSIVE}}", () => possessive)
    .replaceAll("{{PLAYER_CHARACTER}}", () => displayName);
}

export function extractWizardPlayerCharacter(output: string): { playerCharacterName: string; body: string } {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  const markerIndex = lines.findIndex((line) => readPlayerCharacterMarker(line) !== null);
  if (markerIndex < 0) return { playerCharacterName: WIZARD_PLAYER_CHARACTER_FALLBACK, body: output.trim() };
  const playerCharacterName = normalizeWizardPlayerCharacterName(readPlayerCharacterMarker(lines[markerIndex]!));
  lines.splice(markerIndex, 1);
  return { playerCharacterName, body: lines.join("\n").trim() };
}

export function inferCanonicalPlayerCharacterName(prompt: string): string {
  const headingIndex = prompt.indexOf(CANONICAL_PC_PROTECTION_HEADING);
  if (headingIndex < 0) return WIZARD_PLAYER_CHARACTER_FALLBACK;
  const canonicalTail = prompt.slice(headingIndex + CANONICAL_PC_PROTECTION_HEADING.length);
  // Lazy up to the literal sentence tail so a name containing a period
  // ("Dr. Vale", "J.R.") still infers — `[^\n.]` could not cross the dot and
  // silently fell back, disabling the named duplicate_pc_authority lint for
  // exactly those campaigns.
  const match = canonicalTail.match(/^\s*(.{1,120}?) is the player character\./i);
  if (!match?.[1] || match[1].trim().toLowerCase() === WIZARD_PLAYER_CHARACTER_FALLBACK) return WIZARD_PLAYER_CHARACTER_FALLBACK;
  return normalizeWizardPlayerCharacterName(match[1]);
}

const SECTION_A_HEADING = /^##\s+Section\s+A\s*:/i;

/**
 * Remove every generated/edited `## Section A:` block and the PLAYER_CHARACTER
 * marker line so the canonical block can be re-stamped. Skipping runs from a
 * Section A heading to the NEXT `## ` heading of ANY shape. It used to stop
 * only at a heading literally shaped `## Section <B-Z>:`, so an owner who
 * renamed `## Section B: Tone` to `## Tone` in the review textarea — or a
 * model emitting `## B. Tone` — lost the ENTIRE body after Section A and the
 * campaign was created with nothing but the canonical block. Approval
 * additionally refuses to drop text that is not the
 * canonical block — see `findNonCanonicalStrippedLines`.
 */
export function stripWizardPcProtectionSections(prompt: string): string {
  return splitWizardPcProtectionSections(prompt).body;
}

function splitWizardPcProtectionSections(prompt: string): { body: string; removed: string[] } {
  const lines = prompt.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  const removed: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (SECTION_A_HEADING.test(trimmed)) {
      skipping = true;
      removed.push(line);
      continue;
    }
    if (skipping && /^##\s/.test(trimmed)) skipping = false;
    if (skipping || readPlayerCharacterMarker(trimmed) !== null) {
      removed.push(line);
      continue;
    }
    kept.push(line);
  }
  return { body: kept.join("\n").replace(/^\s+|\s+$/g, ""), removed };
}

/**
 * The lines `stripWizardPcProtectionSections` would drop that are NOT part of
 * the canonical block for this player character (nor a Section A heading or
 * the PLAYER_CHARACTER marker). Non-empty means re-stamping would silently
 * discard owner-authored text; the approval path refuses with a 400 instead.
 * The worker's generation path deliberately does not consult this — a model's
 * own Section A prose is exactly what the strip exists to replace.
 */
export function findNonCanonicalStrippedLines(prompt: string, playerCharacterName: string | null | undefined): string[] {
  const canonical = new Set(buildCanonicalPcProtectionBlock(playerCharacterName).split("\n").map((line) => line.trim()).filter(Boolean));
  return splitWizardPcProtectionSections(prompt).removed
    .map((line) => line.trim())
    .filter((line) => line && !SECTION_A_HEADING.test(line) && readPlayerCharacterMarker(line) === null && !canonical.has(line));
}

export function stampCanonicalPcProtectionBlock(prompt: string, playerCharacterName: string | null | undefined): string {
  const body = stripWizardPcProtectionSections(prompt);
  return `${buildCanonicalPcProtectionBlock(playerCharacterName)}${body ? `\n\n${body}` : ""}`;
}

export function lintWizardSystemPrompt(
  prompt: string,
  playerCharacterName: string | null | undefined,
  options: { requireCanonical?: boolean } = {},
): WizardFirmwareLintFinding[] {
  const expected = buildCanonicalPcProtectionBlock(playerCharacterName);
  const exactCount = countOccurrences(prompt, expected);
  const headingCount = countOccurrences(prompt, CANONICAL_PC_PROTECTION_HEADING);
  const findings: WizardFirmwareLintFinding[] = [];
  if ((options.requireCanonical ?? true) && (exactCount !== 1 || headingCount !== 1)) {
    findings.push({
      code: "canonical_pc_block",
      scope: "system_prompt",
      location: "Section A",
      message: exactCount === 0 ? "The canonical player-authority block is missing or altered." : "The canonical player-authority block appears more than once.",
      excerpt: CANONICAL_PC_PROTECTION_HEADING,
      line: null,
    });
  }
  findings.push(...lintInteractionMechanics(stripWizardPcProtectionSections(prompt), "system_prompt", "system prompt", playerCharacterName));
  return dedupeFindings(findings);
}

export function lintWizardCorpusEntry(entry: { name: string; tag: string | null; content: string }, playerCharacterName?: string | null): WizardFirmwareLintFinding[] {
  const findings: WizardFirmwareLintFinding[] = [];
  if (entry.tag?.trim().toLowerCase() === "threads") {
    findings.push({
      code: "reserved_threads_tag",
      scope: "corpus",
      location: entry.name,
      message: "The threads tag is reserved for the thread tracker.",
      excerpt: entry.tag,
      line: null,
    });
  }
  findings.push(...lintInteractionMechanics(entry.content, "corpus", entry.name, playerCharacterName));
  return dedupeFindings(findings);
}

/**
 * Structural-adequacy lint for generated characters.
 *
 * The grit dials govern PLAY and are reversible; a generated corpus is not. A
 * cast produced without red lines, leverage, or concealment yields a world that
 * can only react, and no amount of dialling the stance up afterwards puts teeth
 * into a character sheet that never had them. So softness is caught HERE, at
 * generation, while regenerating is still free.
 *
 * Deliberately MECHANICAL — presence and shape only, never a model judging
 * whether something "feels" menacing enough. A model asked that question brings
 * the same positivity prior we are compensating for.
 *
 * Not gated on any dial: structural capability is generated at full strength for
 * every campaign, including benign ones. A children's antagonist should still
 * have a real plan; it simply renders at depiction tier 0.
 */
export function lintWizardCharacterCapability(entry: {
  name: string;
  tag: string | null;
  startingDrives?: {
    redLines?: string[];
    leverage?: string[];
    concealment?: { secret: string; behavior: string }[];
  };
  startingSchemes?: { steps?: { text: string }[]; targetCitation?: string }[];
}, playerCharacterName?: string | null): WizardFirmwareLintFinding[] {
  const findings: WizardFirmwareLintFinding[] = [];
  if (entry.tag?.trim().toLowerCase() !== "characters") return findings;
  // The player's character is driven by the player and is excluded from NPC
  // automation everywhere else; holding it to NPC capability would be noise.
  if (playerCharacterName && entry.name.trim().toLowerCase() === playerCharacterName.trim().toLowerCase()) return findings;

  const drives = entry.startingDrives;
  const redLines = (drives?.redLines ?? []).filter((r) => r?.trim());
  const leverage = (drives?.leverage ?? []).filter((l) => l?.trim());
  const concealment = (drives?.concealment ?? []).filter((c) => c?.secret?.trim() && c?.behavior?.trim());

  if (redLines.length === 0) {
    findings.push({
      code: "character_without_red_lines",
      scope: "corpus",
      location: entry.name,
      message: "Character has no red lines — nothing they will do to someone who obstructs them. Characters without them cannot oppose anyone.",
      excerpt: entry.name,
      line: null,
    });
  }
  if (leverage.length === 0 && concealment.length === 0) {
    findings.push({
      code: "character_without_leverage_or_secret",
      scope: "corpus",
      location: entry.name,
      message: "Character has neither leverage over anyone nor anything concealed. Nothing to spend and nothing to lose makes a prop.",
      excerpt: entry.name,
      line: null,
    });
  }

  const scheme = entry.startingSchemes?.[0];
  if (scheme) {
    const steps = (scheme.steps ?? []).filter((step) => step?.text?.trim());
    if (steps.length < 3) {
      findings.push({
        code: "scheme_too_shallow",
        scope: "corpus",
        location: entry.name,
        message: `Antagonist scheme has ${steps.length} usable step(s); an escalating plan needs at least 3.`,
        excerpt: entry.name,
        line: null,
      });
    }
    if (!scheme.targetCitation?.trim()) {
      findings.push({
        code: "scheme_without_target",
        scope: "corpus",
        location: entry.name,
        message: "Antagonist scheme cites no target. A scheme with no victim is scenery.",
        excerpt: entry.name,
        line: null,
      });
    }
  }
  return dedupeFindings(findings);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lintInteractionMechanics(text: string, scope: WizardLintScope, location: string, playerCharacterName?: string | null): WizardFirmwareLintFinding[] {
  const findings: WizardFirmwareLintFinding[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // duplicate_pc_authority matched only the literal words player/user/player
  // character — "never write … for <ActualName>" evaded it. Augment with the
  // canonical name.
  const pcName = normalizeWizardPlayerCharacterName(playerCharacterName);
  const namedAuthorityPattern = pcName !== WIZARD_PLAYER_CHARACTER_FALLBACK
    ? new RegExp(String.raw`\b${AUTHORITY_NEGATION}\s+${AUTHORITY_VERB}[^.\n]{0,140}(?<![\p{L}\p{N}_])` + escapeRegExp(pcName) + String.raw`(?![\p{L}\p{N}_])`, "iu")
    : null;
  for (const rule of interactionPatterns) {
    const matches = (line: string) => hasInteractionConflict(line, rule)
      || (rule.code === "duplicate_pc_authority" && namedAuthorityPattern != null && namedAuthorityPattern.test(line));
    const lineIndex = lines.findIndex(matches);
    if (lineIndex < 0) continue;
    findings.push({
      code: rule.code,
      scope,
      location: scope === "system_prompt" ? nearestSection(lines, lineIndex, location) : location,
      message: rule.message,
      excerpt: lines[lineIndex]!.trim().slice(0, 240),
      line: lineIndex + 1,
    });
  }
  return findings;
}

function hasInteractionConflict(line: string, rule: typeof interactionPatterns[number]): boolean {
  if (rule.code !== "floor_yielding_absolute" && rule.code !== "world_passivity") return rule.pattern.test(line);
  for (const match of line.matchAll(new RegExp(rule.pattern.source, "gi"))) {
    // Negation applies within its clause. Check every occurrence: a harmless
    // "never wait" must not hide a later positive "but wait for the player".
    const prefix = line.slice(0, match.index).split(/[.!?;,]|\b(?:but|however)\b/i).at(-1) ?? "";
    const negated = /\b(?:never|not|cannot|can't|don't|doesn't|mustn't|shouldn't|without|avoid|rather than|instead of)\b[^.!?;,]{0,140}$/i.test(prefix);
    if (!negated) return true;
    // "Never advance UNTIL the player acts" still demands waiting; only a
    // negated wait/await verb makes that trailing condition harmless.
    if (/^(?:until|unless)\b/i.test(match[0]) && !/\b(?:wait|waits|waiting|await|awaits|awaiting)\b/i.test(prefix)) return true;
  }
  return false;
}

function nearestSection(lines: string[], lineIndex: number, fallback: string): string {
  for (let index = lineIndex; index >= 0; index -= 1) {
    const heading = lines[index]!.trim().match(/^##\s+(.+)$/);
    if (heading?.[1]) return heading[1].trim();
  }
  return fallback;
}

function dedupeFindings(findings: WizardFirmwareLintFinding[]): WizardFirmwareLintFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.scope}:${finding.location}:${finding.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = value.indexOf(needle, cursor)) >= 0) {
    count++;
    cursor += needle.length;
  }
  return count;
}
