// Presence resolution (2026-09-29, the scene-present over-match).
//
// A scene lists who is present by name. Two consumers need to know which `characters` entries ARE those people:
// the engine's scene-present guarantee (the person's own core is forced into context) and the rolling diff's
// coverage contract (the entries it must show in full and account for). Both used a loose matcher that also
// accepted an entry whose annotation mentions the person ("Petra Kesh — Corin Vale's … Source"), an entry that
// carries the person's name as a retrieval key (Doran Ash keyed "Bram Ryder"), and an entry whose key is
// part of the name (Mara's "ryder" for a present "Nessa Ryder"). Measured on 2026-09-29 across two long campaigns:
// those made up every one of the 74 non-identity matches, and about 45 % of the
// forced-entry tokens. An entry about someone else keeps competing on its keys; it just is not that person.
//
// Identities: entries sharing a base name (a core and its aspect entries) are one person, and so are names that nest
// without ambiguity ("Aldric Hale" in "Aldric Doran Hale"; "The Mayor", "Mayor Thorne" and "Mayor Ryn Thorne
// III"), or that nest and name each other in their keys where the nesting branches.
//
// Resolution walks tiers and stops at the first that finds someone:
//   0. the player character: a name in the session's player-character keys resolves only to the PC's own entries (an
//      identity named by one of the multi-word PC keys, as in a campaign whose PC has "Corin Vale — …" entries),
//      never to anyone else: the PC's core is normally a constant, and the PC's name on another entry is a
//      relationship;
//   1. own name — the entry's name (before " — ", a leading title aside) or an alias written into it: a quoted
//      nickname, either side of a slash, a parenthetical or annotation that is a person's name;
//   2. part of the person's own name, in order ("Kesh" → "Señor Kesh", "Bram Hale" → "Hale"); two
//      different people fitting are told apart by the recent text, otherwise a small set is loaded whole;
//   3. a key that names one person: carried by one identity, or by several of which one shares a word with the name
//      or lists it among its first keys (a nickname); otherwise a key several people carry is a relationship;
//   4. with no entry of their own, the one entry sharing the surname that also names this person: it carries their
//      given name as a key ("Ryn Thorne" → "Doran Thorne", keyed "Ryn"), or its whole name, title included,
//      is within theirs ("Reverend Bram Ash" → "Reverend Ash"); a relative keyed with their own given name
//      ("Kesh Marlow" → "Petra Marlow") or a role name ("Gate Corporal" → "Search-Party Corporal") is not them;
//   5. a one-letter typo in one longer word ("Keeper Aldris" → "Keeper Aldric").
// Names are cleaned first: split-list fragments ("Mara (asleep", "behind closed door)") are repaired or dropped, and
// the people a group note names ("the deputies (Bram Ryder, Nessa Hale)") are read when they have entries.
import { characterNameKey, withoutLeadingTitles } from "../chat/characterNames";
import { ScanIndex } from "./scanIndex";

export interface PresenceEntry {
  id: string;
  name: string;
  tag: string | null;
  keys: readonly string[];
}

export type PresenceTier =
  | "own-name"
  | "partial-name"
  | "partial-name-disambiguated"
  | "partial-name-ambiguous"
  | "alias-key"
  | "surname"
  | "typo"
  | "player-character"
  | "ambiguous-unresolved"
  | "not-a-name"
  | "none";

export interface PresenceResolution {
  /** The name as the scene gave it (for a person read from a group note, the name inside the note). */
  name: string;
  tier: PresenceTier;
  /** The entries that ARE this person (all entries of every resolved identity). */
  entryIds: string[];
  /** For the ambiguous tiers: the names (as written on the entries) of the people that fit. */
  candidates: string[];
  /** The resolved people's names as written on their entries, for notes. */
  resolvedNames: string[];
}

/** One entry's own names and keys. The text scan counts an entry by these, never by its identity's other entries'. */
export interface IdentityEntry {
  id: string;
  /** Name keys the entry's own name gives: its base and the aliases written into it that survived the alias rules. */
  names: string[];
  /** Its keys, lowercased as written, in the entry's order. */
  keys: string[];
}

export interface CharacterIdentity {
  /** The name key of the identity's fullest name: the entry name before " — ", parentheticals and quotes removed,
   *  leading title dropped. */
  key: string;
  /** That name as written on the entry ("Señor Kesh"), for notes. */
  display: string;
  /** Every name this identity answers to, as name keys: each member's base name and surviving aliases. */
  names: string[];
  /** Name tokens of `key` (stop words dropped), in order. */
  tokens: string[];
  /** Name tokens of every member's base name (one identity can hold several nested names). */
  tokenSets: string[][];
  /** The same names as written, a leading title kept ("sheriff doran vale"), so "Sheriff Vale" fits. */
  writtenTokenSets: string[][];
  /** "Bram's Known Languages": an entry about something belonging to a person, never that person. */
  possessive: boolean;
  entryIds: string[];
  /** Every key its entries carry, lowercased as written (a key keeps its title: "king of the marches"). */
  keys: Set<string>;
  /** A key's best position in any of its entries' key lists (0 = first). Writers list name variants first. */
  keyRank: Map<string, number>;
  /** The same, by the key's name key (a leading title dropped), for resolving a present name. */
  nameKeyRank: Map<string, number>;
  entries: IdentityEntry[];
}

/** Most entries a genuinely ambiguous partial name may load (two Petras load both; ten Corins load none). */
export const PRESENCE_MAX_AMBIGUOUS = 3;
/** Partial names match identities of at most this many name tokens ("What Kesh Knows About Corin Vale" is a
 *  description, not a name). */
const PARTIAL_MAX_TOKENS = 4;
/** A key several people carry names the one holder that lists it among its first this-many keys (a nickname). */
const EARLY_KEY_RANK = 3;
const STOP_TOKENS = new Set(["and", "the", "of", "called", "de", "la", "le", "van", "von", "der", "del", "da", "a", "an"]);
/** A key made only of these is never a name ("she" on an entry would match every other sentence). */
const PRONOUNS = new Set(["he", "she", "her", "hers", "him", "his", "they", "them", "their", "it", "its", "we", "us", "you", "i", "me", "my"]);
const ANNOTATION_SPLIT = /\s+[—–-]\s+/;
const PROPER_NAME = /^\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*)+$/u;
const PLAIN_NAME = /^\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*){0,2}$/u;
const POSSESSIVE = /\p{L}['’]s\b/u;
/** Tiers a person read from a group note may resolve through: plain identifications, never a guess. */
const NOTE_MEMBER_TIERS = new Set<PresenceTier>(["own-name", "partial-name", "partial-name-disambiguated", "alias-key", "player-character"]);

function nameTokens(key: string): string[] {
  return key
    .toLocaleLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => t.length > 0 && !STOP_TOKENS.has(t));
}

function normalizeKey(raw: unknown): string {
  return String(raw ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isSubsequence(needle: readonly string[], hay: readonly string[]): boolean {
  if (needle.length === 0) return false;
  let j = 0;
  for (const t of hay) if (t === needle[j]) j++;
  return j === needle.length;
}

function isChain(sets: readonly (readonly string[])[]): boolean {
  return sets.every((a) => sets.every((b) => a === b || isSubsequence(a, b) || isSubsequence(b, a)));
}

function pronounOnly(name: string): boolean {
  const words = name.toLocaleLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => PRONOUNS.has(w) || STOP_TOKENS.has(w));
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * A present-list name as a person's name: balanced parentheticals removed ("Ryn (unconscious)" → "Ryn"), an
 * unclosed parenthetical tail cut ("Mara (asleep" → "Mara", the head of a note a comma split), and null for the
 * tail of a split note ("behind closed door)") or an empty result.
 */
export function cleanPresentName(raw: string): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (text.includes(")") && !text.includes("(")) return null;
  const cleaned = text.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s*\([^)]*$/, "").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/** The people a present-list item's note names: proper names of two or more words inside its parentheses ("the
 *  deputies (Bram Ryder, Nessa Hale)"). States and places ("asleep", "Cell 6") are not names. */
export function presentNoteMembers(raw: string): string[] {
  const out: string[] = [];
  for (const m of String(raw ?? "").matchAll(/\(([^()]*)\)/g)) {
    for (const part of m[1]!.split(/\s*(?:,|;|&|\band\b)\s*/u)) {
      const name = part.trim();
      if (PROPER_NAME.test(name) && !POSSESSIVE.test(name)) out.push(name);
    }
  }
  return out;
}

/** The names an entry is: its base (before the first " — "), without parentheticals or quotes, and the aliases
 *  written into the name. A quoted nickname and either side of a slash always count; when a quoted nickname leaves at
 *  most one word behind ("Unidentified “Stranger”", `"Big Ryn"`), the base keeps it. A parenthetical or an
 *  annotation after the dash counts only when the entry also carries it as a key ("Nessa Hale (Grey)" keyed "Grey",
 *  "The Widow — Petra Ash" keyed "Petra Ash"): unkeyed, they are roles and topics ("Kesh (Father)", "X — Harbor
 *  Detective", "X — Background"). */
export function entryIdentityNames(name: string, keys: readonly string[] = []): { base: string; aliases: string[]; possessive: boolean } {
  const keyed = new Set(keys.map((k) => characterNameKey(String(k ?? ""))));
  const personal = (alias: string) => keyed.has(characterNameKey(alias));
  const clean = (text: string) => text.replace(/\s*\([^)]*\)\s*/g, " ").replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  const parts = String(name ?? "").split(ANNOTATION_SPLIT);
  const base0 = (parts[0] ?? "").trim();
  const aliases: string[] = [];
  for (const m of base0.matchAll(/\(([^)]*)\)/g)) {
    const alias = m[1]!.replace(/^["“'‘]|["”'’]$/g, "").trim();
    if (/^\p{Lu}/u.test(alias) && wordCount(alias) <= 3 && !POSSESSIVE.test(alias) && personal(alias)) aliases.push(alias);
  }
  // "Nessa 'Gran' Ryder": the quoted nickname is an alias, and the base is the name without it.
  let unquoted = base0, withNickname = base0, quoted = 0;
  for (const m of base0.matchAll(/["“'‘]([^"”'’]{2,30})["”'’]/g)) {
    if (!/^\p{Lu}/u.test(m[1]!)) continue;
    aliases.push(m[1]!.trim());
    unquoted = unquoted.replace(m[0], " ");
    withNickname = withNickname.replace(m[0], ` ${m[1]} `);
    quoted++;
  }
  let base = clean(unquoted);
  if (quoted > 0 && wordCount(base) <= 1) base = clean(withNickname);
  if (!base) base = aliases[0] ?? clean(base0.replace(/[()]/g, " "));
  // "Bram / The Wolf", "Doran Ash / Ironside": each side of a slash is a name, and the first is the base (the
  // second's words are never read as parts of the first's name).
  if (base.includes("/")) {
    const sides = base.split("/").map((side) => side.trim()).filter(Boolean);
    aliases.push(...sides);
    if (sides[0]) base = sides[0];
  }
  // "The Widow — Petra Ash": an annotation that is itself a person's name (capitalized, no possessive, ≤ 3 words).
  const annotation = parts.slice(1).join(" — ").trim();
  if (annotation && PLAIN_NAME.test(annotation) && !POSSESSIVE.test(annotation) && personal(annotation)) aliases.push(annotation);
  return { base, aliases, possessive: POSSESSIVE.test(base) };
}

export interface BuildIdentityOptions {
  /** Name keys whose identities never merge with another (the player character's own entries). */
  protectedNames?: ReadonlySet<string>;
}

/** Identities of a campaign's `characters` entries. Entries sharing a base name are one identity; nested names are
 *  merged when the nesting is a chain ("The Mayor" ⊂ "Mayor Thorne" ⊂ "Mayor Ryn Thorne III"), or, where it
 *  branches, with the longer names that name the shorter in their keys or the other way round. An alias several
 *  identities share, or one that is another identity's base name, is dropped: it is a role or someone else's name. */
export function buildCharacterIdentities(entries: readonly PresenceEntry[], options: BuildIdentityOptions = {}): CharacterIdentity[] {
  interface Base { key: string; display: string; tokens: string[]; written: string[]; possessive: boolean; entries: IdentityEntry[]; aliases: Map<string, string[]> }
  const bases = new Map<string, Base>();
  for (const entry of entries) {
    if (entry.tag !== "characters") continue;
    const keys = (Array.isArray(entry.keys) ? entry.keys : []).map(normalizeKey).filter(Boolean);
    const { base, aliases, possessive } = entryIdentityNames(String(entry.name ?? ""), keys);
    const key = characterNameKey(base);
    if (!key) continue;
    let b = bases.get(key);
    if (!b) {
      b = { key, display: base, tokens: nameTokens(key), written: nameTokens(base), possessive, entries: [], aliases: new Map() };
      bases.set(key, b);
    }
    b.aliases.set(entry.id, [...new Set(aliases.map((a) => characterNameKey(a)).filter((a) => a && a !== key))]);
    b.entries.push({ id: entry.id, names: [key], keys });
  }
  // Aliases shared by several base identities, or equal to another's base name, name nobody in particular.
  const aliasHolders = new Map<string, Set<string>>();
  for (const b of bases.values()) for (const list of b.aliases.values()) for (const a of list) {
    if (!aliasHolders.has(a)) aliasHolders.set(a, new Set());
    aliasHolders.get(a)!.add(b.key);
  }
  for (const b of bases.values()) {
    for (const e of b.entries) {
      for (const a of b.aliases.get(e.id) ?? []) {
        if ((aliasHolders.get(a)?.size ?? 0) > 1 || bases.has(a) || pronounOnly(a)) continue;
        if (!e.names.includes(a)) e.names.push(a);
      }
    }
  }

  // Merge nested names (union-find over the base identities).
  const list = [...bases.values()];
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  const protectedNames = options.protectedNames ?? new Set<string>();
  const namesOf = list.map((b) => new Set(b.entries.flatMap((e) => e.names)));
  const keysOf = list.map((b) => new Set(b.entries.flatMap((e) => e.keys.map((k) => characterNameKey(k)))));
  const candidate = list.map((b, i) => !b.possessive && b.tokens.length >= 1 && b.tokens.length <= PARTIAL_MAX_TOKENS
    && ![...namesOf[i]!].some((n) => protectedNames.has(n)));
  for (let y = 0; y < list.length; y++) {
    if (!candidate[y]) continue;
    const Y = list[y]!;
    const supersets: number[] = [];
    for (let x = 0; x < list.length; x++) {
      if (x === y || !candidate[x] || list[x]!.tokens.length <= Y.tokens.length) continue;
      if (isSubsequence(Y.tokens, list[x]!.tokens)) supersets.push(x);
    }
    if (supersets.length === 0) continue;
    let pick = supersets;
    if (!isChain(supersets.map((x) => list[x]!.tokens))) {
      pick = supersets.filter((x) => [...namesOf[x]!].some((n) => keysOf[y]!.has(n)) || [...namesOf[y]!].some((n) => keysOf[x]!.has(n)));
      if (pick.length === 0 || !isChain(pick.map((x) => list[x]!.tokens))) continue;
    }
    for (const x of pick) union(y, x);
  }

  const groups = new Map<number, Base[]>();
  list.forEach((b, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(b); });
  const identities: CharacterIdentity[] = [];
  for (const members of groups.values()) {
    const primary = members.reduce((best, b) => (b.tokens.length > best.tokens.length ? b : best), members[0]!);
    const ordered = [primary, ...members.filter((m) => m !== primary)];
    const names: string[] = [];
    for (const b of ordered) for (const e of b.entries) for (const n of e.names) if (!names.includes(n)) names.push(n);
    const identity: CharacterIdentity = {
      key: primary.key,
      display: primary.display,
      names,
      tokens: primary.tokens,
      tokenSets: members.map((b) => b.tokens),
      writtenTokenSets: members.map((b) => b.written),
      possessive: members.every((b) => b.possessive),
      entryIds: members.flatMap((b) => b.entries.map((e) => e.id)),
      keys: new Set(),
      keyRank: new Map(),
      nameKeyRank: new Map(),
      entries: members.flatMap((b) => b.entries),
    };
    for (const e of identity.entries) {
      e.keys.forEach((k, rank) => {
        identity.keys.add(k);
        identity.keyRank.set(k, Math.min(identity.keyRank.get(k) ?? Infinity, rank));
        const nk = characterNameKey(k);
        identity.nameKeyRank.set(nk, Math.min(identity.nameKeyRank.get(nk) ?? Infinity, rank));
      });
    }
    identities.push(identity);
  }
  return identities;
}

function oneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export interface PresenceResolverOptions {
  /** The session's player-character names (and aliases): they resolve only to the PC's own entries, and are never
   *  another entry's alias. */
  playerNames?: readonly string[];
  maxAmbiguous?: number;
}

type Span = { identity: CharacterIdentity; start: number; end: number };

/** Resolves present-list names to the entries that are those people, and finds the characters a text mentions.
 *  Build once per campaign snapshot; `resolve` and `appearedIn` are then cheap. */
export class PresenceResolver {
  readonly identities: CharacterIdentity[];
  private readonly byName = new Map<string, CharacterIdentity[]>();
  /** Keys as written → the identities carrying them (the text scan). */
  private readonly keyHolders = new Map<string, CharacterIdentity[]>();
  /** Keys as name keys (a leading title dropped) → the identities carrying them (resolving a present name). */
  private readonly nameKeyHolders = new Map<string, CharacterIdentity[]>();
  /** Name tokens → the person-like identities (not possessive, at most PARTIAL_MAX_TOKENS words) whose names hold them. */
  private readonly tokenOwners = new Map<string, CharacterIdentity[]>();
  private readonly playerKeys: Set<string>;
  /** The player-character names as the text scan matches them (lowercased as written). */
  private readonly playerTexts: string[];
  /** Identities named by a multi-word player-character name: the PC's own entries. A one-word PC key ("Corin") can
   *  be an NPC's name too, so it never makes an identity the PC's. */
  private readonly playerIdentities: Set<CharacterIdentity>;
  private readonly maxAmbiguous: number;
  private readonly keyVerdicts = new Map<CharacterIdentity, Map<string, boolean>>();
  private readonly entryNameCache = new Map<string, string[]>();
  private recentIndex: { text: string; index: ScanIndex } | null = null;

  constructor(entries: readonly PresenceEntry[], options: PresenceResolverOptions = {}) {
    const playerNames = (options.playerNames ?? []).map((n) => String(n ?? "").trim()).filter(Boolean);
    this.playerKeys = new Set(playerNames.map((n) => characterNameKey(n)).filter(Boolean));
    this.playerTexts = [...new Set(playerNames.map((n) => normalizeKey(n)).filter((n) => n.length >= 3 && !pronounOnly(n)))];
    const fullPlayerKeys = new Set(playerNames.filter((n) => wordCount(n) >= 2).map((n) => characterNameKey(n)));
    this.identities = buildCharacterIdentities(entries, { protectedNames: fullPlayerKeys });
    this.maxAmbiguous = options.maxAmbiguous ?? PRESENCE_MAX_AMBIGUOUS;
    const add = (map: Map<string, CharacterIdentity[]>, key: string, identity: CharacterIdentity) => {
      const list = map.get(key);
      if (!list) map.set(key, [identity]);
      else if (!list.includes(identity)) list.push(identity);
    };
    for (const identity of this.identities) {
      for (const name of identity.names) add(this.byName, name, identity);
      for (const k of identity.keys) {
        add(this.keyHolders, k, identity);
        add(this.nameKeyHolders, characterNameKey(k), identity);
      }
      if (!identity.possessive) {
        for (const ts of identity.tokenSets) if (ts.length <= PARTIAL_MAX_TOKENS) for (const t of ts) add(this.tokenOwners, t, identity);
      }
    }
    this.playerIdentities = new Set(this.identities.filter((i) => i.names.some((n) => fullPlayerKeys.has(n))));
  }

  /** Resolve one present-list name. `recentText` (the turn's scan window) tells apart two people a partial name fits. */
  resolve(rawName: string, recentText = ""): PresenceResolution {
    const result = (tier: PresenceTier, found: CharacterIdentity[] = [], candidates: CharacterIdentity[] = []): PresenceResolution => ({
      name: rawName,
      tier,
      entryIds: [...new Set(found.flatMap((i) => i.entryIds))],
      candidates: candidates.map((i) => i.display),
      resolvedNames: found.map((i) => i.display),
    });
    const cleaned = cleanPresentName(rawName);
    if (!cleaned) return result("not-a-name");
    const pk = characterNameKey(cleaned);
    const pt = nameTokens(pk);
    if (!pk || pt.length === 0) return result("not-a-name");

    // 0 — the player character, under any of their names or a title before one ("Mr Vale"): only the PC's own
    // entries, by full or partial name ("Corin" → "Corin Vale — Origin"), never someone else's name, key or surname.
    if (this.playerKeys.has(pk) || this.playerKeys.has(characterNameKey(withoutLeadingTitles(cleaned)))) {
      return result("player-character", [...this.playerIdentities].filter((i) => i.tokenSets.some((ts) => isSubsequence(pt, ts))));
    }

    // 1 — own name, or an alias written into an entry's name.
    const own = this.byName.get(pk) ?? [];
    if (own.length > this.maxAmbiguous) return result("ambiguous-unresolved", [], own);
    if (own.length > 0) return result("own-name", own);

    // 2 — part of a person's own name, in order, with or without a leading title ("Sheriff Vale" and "Vale"
    // both fit "Sheriff Doran Vale").
    const written = nameTokens(cleaned);
    const partial = this.identities.filter((i) => !i.possessive && (
      i.tokenSets.some((ts) => ts.length <= PARTIAL_MAX_TOKENS && (isSubsequence(pt, ts) || isSubsequence(ts, pt)))
      || (written.length >= 2 && i.writtenTokenSets.some((ws) => ws.length <= PARTIAL_MAX_TOKENS + 1 && (isSubsequence(written, ws) || isSubsequence(ws, written))))));
    if (partial.length === 1) return result("partial-name", partial);
    if (partial.length > 1) {
      const narrowed = recentText ? partial.filter((i) => this.mentionedIn(i, pt, recentText)) : [];
      if (narrowed.length === 1) return result("partial-name-disambiguated", narrowed, partial);
      const pool = narrowed.length > 0 ? narrowed : partial;
      if (pool.length <= this.maxAmbiguous) return result("partial-name-ambiguous", pool, partial);
      return result("ambiguous-unresolved", [], partial);
    }

    // 3 — a key naming this person: carried by one identity; or by several, of which exactly one shares a word with
    // the name, or exactly one lists it among its first keys (a nickname: "Bram" first on Bram Ryder, far down on
    // Mara's list as a relationship).
    const holders = this.nameKeyHolders.get(pk) ?? [];
    if (holders.length === 1) return result("alias-key", holders);
    if (holders.length > 1) {
      const overlap = holders.filter((i) => pt.some((t) => i.tokenSets.some((ts) => ts.includes(t))));
      if (overlap.length === 1) return result("alias-key", overlap);
      const early = holders.filter((i) => (i.nameKeyRank.get(pk) ?? Infinity) < EARLY_KEY_RANK);
      if (early.length === 1) return result("alias-key", early);
    }

    // 4 — no entry of their own: the one entry sharing the surname of a proper name that also names this person, by
    // a given-name key or by its whole name (title included) within theirs.
    if (pt.length >= 2 && PROPER_NAME.test(cleaned)) {
      const last = pt[pt.length - 1]!;
      const given = pt.slice(0, -1);
      const surname = this.identities.filter((i) => !i.possessive
        && i.tokenSets.some((ts) => ts.length >= 2 && ts.length <= PARTIAL_MAX_TOKENS && ts[ts.length - 1] === last)
        && (given.some((t) => i.keys.has(t)) || i.tokenSets.some((ts) => isSubsequence(ts, written)) || i.writtenTokenSets.some((ws) => isSubsequence(ws, written))));
      if (surname.length === 1) return result("surname", surname);
    }

    // 5 — a one-letter typo in one word of five or more letters, every other word equal.
    const typo = this.identities.filter((i) => i.tokenSets.some((ts) => ts.length === pt.length
      && ts.every((t, k) => oneEdit(t, pt[k]!))
      && ts.filter((t, k) => t !== pt[k]).length === 1));
    if (typo.length === 1) return result("typo", typo);

    return result(holders.length > 1 ? "ambiguous-unresolved" : "none", [], holders);
  }

  /** Does the recent text name this candidate beyond the words the present name already gave: its full name, or one
   *  of its other name words written as a name (capitalised, not opening a sentence)? "Petra rose from the stool",
   *  "May I come in" and "the man said" are words, not names. */
  private mentionedIn(i: CharacterIdentity, given: readonly string[], recentText: string): boolean {
    const index = this.indexFor(recentText);
    const original = index.text;
    // Every name word of the occurrence capitalised as written ("Petra Rose", not "Petra rose").
    const writtenAsName = (start: number, length: number) => original.slice(start, start + length).split(/\s+/)
      .every((word) => STOP_TOKENS.has(word.toLocaleLowerCase()) || (word[0] !== undefined && word[0] !== word[0].toLocaleLowerCase()));
    for (const n of i.names) {
      if (n.length < 3 || !nameTokens(n).some((t) => !given.includes(t))) continue;
      if (index.wholeWordStarts(n.toLowerCase(), false).some((start) => writtenAsName(start, n.length))) return true;
    }
    for (const ts of i.tokenSets) {
      for (const t of ts) {
        if (given.includes(t) || t.length < 2) continue;
        for (const start of index.wholeWordStarts(t.toLowerCase(), false)) {
          const first = original[start] ?? "";
          if (first === first.toLocaleLowerCase() || first !== first.toLocaleUpperCase()) continue;
          let k = start - 1;
          while (k >= 0 && /\s/u.test(original[k]!)) k--;
          if (k >= 0 && !/[.!?"“”\n]/u.test(original[k]!)) return true;
        }
      }
    }
    return false;
  }

  private indexFor(text: string): ScanIndex {
    if (this.recentIndex?.text !== text) this.recentIndex = { text, index: new ScanIndex(text) };
    return this.recentIndex.index;
  }

  /** Resolve a present list; `entryIds` is the union in list order. The people a group note names are read after
   *  their item when they plainly have entries of their own (a miss inside a note is not reported). */
  resolveAll(names: readonly string[], recentText = ""): { entryIds: string[]; resolutions: PresenceResolution[] } {
    const resolutions: PresenceResolution[] = [];
    for (const name of names) {
      resolutions.push(this.resolve(name, recentText));
      for (const member of presentNoteMembers(name)) {
        const found = this.resolve(member, recentText);
        if (found.entryIds.length > 0 && NOTE_MEMBER_TIERS.has(found.tier)) resolutions.push(found);
      }
    }
    const entryIds: string[] = [];
    for (const r of resolutions) for (const id of r.entryIds) if (!entryIds.includes(id)) entryIds.push(id);
    return { entryIds, resolutions };
  }

  /** Does key `k` name identity `i`? Not another person's own name or part of it (a relationship key), not a
   *  player-character name unless `i` is the PC's own identity, not a pronoun, and a key several people carry only as
   *  part of this person's own name (a family surname) or as the one holder's early key (a nickname). */
  private keyNames(i: CharacterIdentity, k: string): boolean {
    let verdicts = this.keyVerdicts.get(i);
    if (!verdicts) { verdicts = new Map(); this.keyVerdicts.set(i, verdicts); }
    const known = verdicts.get(k);
    if (known !== undefined) return known;
    const verdict = ((): boolean => {
      const nameKey = characterNameKey(k);
      if ((this.playerKeys.has(k) || this.playerKeys.has(nameKey)) && !this.playerIdentities.has(i)) return false;
      if (i.names.includes(k) || i.names.includes(nameKey)) return true;
      if ([...(this.byName.get(k) ?? []), ...(this.byName.get(nameKey) ?? [])].some((owner) => owner !== i)) return false;
      const kt = nameTokens(k);
      if (kt.length === 0 || pronounOnly(k)) return false;
      const ownPart = i.tokenSets.some((ts) => isSubsequence(kt, ts));
      if (!ownPart && (this.tokenOwners.get(kt[0]!) ?? []).some((j) => j !== i && j.tokenSets.some((ts) => isSubsequence(kt, ts)))) return false;
      const holders = this.keyHolders.get(k) ?? [];
      if (holders.length > 1 && !ownPart) {
        const early = holders.filter((h) => (h.keyRank.get(k) ?? Infinity) < EARLY_KEY_RANK);
        return early.length === 1 && early[0] === i;
      }
      return true;
    })();
    verdicts.set(k, verdict);
    return verdict;
  }

  /** The names under which a text mentions one entry: its own name and aliases, and those of its keys that name its
   *  identity (`keyNames`). An entry is never counted by another entry's keys, so a person's aspect entries do not
   *  all appear whenever the person is named. */
  entrySelfNames(identity: CharacterIdentity, entry: IdentityEntry): string[] {
    const cached = this.entryNameCache.get(entry.id);
    if (cached) return cached;
    // A player-character name is the PC's, even when it is also this entry's own name ("Corin" on an NPC).
    const someoneElse = !this.playerIdentities.has(identity);
    const names = new Set(entry.names.filter((n) => !pronounOnly(n) && !(someoneElse && this.playerKeys.has(n))));
    for (const k of entry.keys) if (!names.has(k) && this.keyNames(identity, k)) names.add(k);
    const out = [...names].filter((n) => n.length >= 3);
    this.entryNameCache.set(entry.id, out);
    return out;
  }

  /** Every name under which a text mentions any of the identity's entries. */
  selfNames(identity: CharacterIdentity): string[] {
    return [...new Set(identity.entries.flatMap((e) => this.entrySelfNames(identity, e)))];
  }

  /** Ids of the entries a text mentions by one of their own self names (whole words, case-insensitive), in identity
   *  order. A mention inside another person's own name belongs to that person: "Thorne" inside "Ryn Thorne" is Ryn,
   *  not every Thorne; a bare "Thorne" is every Thorne who carries the surname. A mention inside a player-character
   *  name ("Corin" in "Corin Vale") is the PC's. A possessive topic entry's name ("Mara's Known Languages") never
   *  takes a mention from the person it is about. */
  appearedIn(text: string): string[] {
    if (!text) return [];
    const index = this.indexFor(text);
    const ownNameSpans: Span[] = [];
    let longestOwnName = 0;
    for (const identity of this.identities) {
      if (identity.possessive) continue;
      for (const name of identity.names) {
        if (name.length < 3 || pronounOnly(name)) continue;
        const key = name.toLowerCase();
        for (const start of index.wholeWordStarts(key, false)) ownNameSpans.push({ identity, start, end: start + key.length });
        longestOwnName = Math.max(longestOwnName, key.length);
      }
    }
    // The player character's names own their spans too, for everyone but the PC's own entries (`pcOwner` stands in
    // when the PC has none).
    const pcOwner = { possessive: false } as CharacterIdentity;
    for (const name of this.playerTexts) {
      for (const start of index.wholeWordStarts(name, false)) ownNameSpans.push({ identity: pcOwner, start, end: start + name.length });
      longestOwnName = Math.max(longestOwnName, name.length);
    }
    ownNameSpans.sort((a, b) => a.start - b.start);
    const firstStartAtOrAfter = (pos: number): number => {
      let lo = 0, hi = ownNameSpans.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ownNameSpans[mid]!.start < pos) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const shadowed = (m: Span): boolean => {
      // Own-name spans that could contain m start within longestOwnName before it, at the latest where m starts.
      for (let k = firstStartAtOrAfter(m.start + 1) - 1; k >= 0; k--) {
        const o = ownNameSpans[k]!;
        if (o.start < m.start - longestOwnName) break;
        if (o.identity === pcOwner && this.playerIdentities.has(m.identity)) continue;
        if (o.identity !== m.identity && o.start <= m.start && m.end <= o.end && o.end - o.start > m.end - m.start) return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const identity of this.identities) {
      for (const entry of identity.entries) {
        const mentioned = this.entrySelfNames(identity, entry).some((name) => {
          const key = name.toLowerCase();
          return index.wholeWordStarts(key, false).some((start) => !shadowed({ identity, start, end: start + key.length }));
        });
        if (mentioned) out.push(entry.id);
      }
    }
    return out;
  }
}

/** One context note for the present names worth a look: those that found no entry, an ambiguous name that loaded
 *  several people or none, and the guesses (surname, typo). Null when every name resolved plainly. Player characters
 *  and split fragments are left out. */
export function describePresence(resolutions: readonly PresenceResolution[]): string | null {
  const seen = new Set<string>();
  const missing: string[] = [];
  const several: string[] = [];
  const guessed: string[] = [];
  for (const r of resolutions) {
    const name = cleanPresentName(r.name) ?? r.name.trim();
    if (!name || seen.has(name.toLocaleLowerCase())) continue;
    seen.add(name.toLocaleLowerCase());
    const fits = (list: string[]) => `${list.slice(0, 4).join(", ")}${list.length > 4 ? ` and ${list.length - 4} more` : ""}`;
    if (r.tier === "none") missing.push(name);
    else if (r.tier === "ambiguous-unresolved") several.push(`${name} fits ${r.candidates.length} people (${fits(r.candidates)}), so none was loaded`);
    else if (r.tier === "partial-name-ambiguous") several.push(`${name} fits ${fits(r.resolvedNames)}, so all were loaded`);
    else if (r.tier === "surname") guessed.push(`${name} as ${r.resolvedNames[0]} (same surname)`);
    else if (r.tier === "typo") guessed.push(`${name} as ${r.resolvedNames[0]} (one letter apart)`);
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`no character entry for ${missing.join(", ")}`);
  if (several.length > 0) parts.push(several.join("; "));
  if (guessed.length > 0) parts.push(`read ${guessed.join(", ")}`);
  return parts.length > 0 ? `Scene presence: ${parts.join("; ")}.` : null;
}
