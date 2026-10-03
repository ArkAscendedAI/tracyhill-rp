// Living World Phase 2 — in-world clock helpers. In-world dates are freeform
// user/LLM strings ("Sept 30, 1998", "Oct 2, 1998 3:00 AM"); we parse
// defensively and NEVER guess: unparseable ⇒ null epoch, and callers fall back
// to manual handling (spec: "unparseable ⇒ skip, never guess").
//
// What counts as a date: a label parses only when it
// carries a calendar date — a month name with a day or year ("Oct 5", "June
// 2008", "Thursday, August 28, 2008") or a numeric date ("2008-08-28",
// "06/13/2008"). Everything else is null. V8's Date.parse is lenient enough to
// read "Thursday, 2000", "Saturday night, 2000" and "two days later, 2000" as
// January 1, 2000, so the ", 2000" fallback below turned a relative or
// weekday-only scene label into January 1 — which the nearest-year re-anchor
// then moved to January 1 of the campaign year: a 125-day "gap" on an August
// watermark, a weeks-scale catch-up window for what the story called two days,
// a watermark the backward-clock guard could never correct, and every
// date-gated beat before January due at once. Relative time belongs in the
// narrative; the scene firmware no longer offers it as a `date` value.

export interface WorldClock {
  simulatedThrough: string;
  simulatedThroughEpoch: number | null;
  updatedAt: string;
}

/**
 * Parse a freeform in-world date to an epoch, or null (never guess).
 *
 * `anchorEpoch` (2026-09-02): the campaign's current position in story time —
 * the world-clock watermark, the tick window, or story-now. A YEAR-LESS label
 * ("Oct 5", the form models routinely emit for a beat's `afterInWorld`) is
 * re-anchored to the year nearest that epoch. Without this, V8 parses "Oct 5" as
 * Oct 5 2001, so in a 1998 campaign the beat sat pending forever (2001 > 1998 —
 * never due) and in a 2024 campaign it was due immediately (2001 < 2024). The
 * nearest of {Y-1, Y, Y+1} is chosen rather than always rolling forward, so
 * "Jan 3" against a Dec 28 watermark lands in the NEXT year while "Sept 30"
 * against Oct 2 stays a just-past date (due now, like a dateless beat) instead
 * of jumping a year ahead. Without an anchor the pre-existing behavior is kept
 * (labels that never carry a year still order consistently among themselves).
 */
/** How a YEAR-LESS label picks its year against `anchorEpoch`. */
export interface ParseInWorldDateOptions {
  /**
   * - `"nearest"` (default): the nearest of {Y-1, Y, Y+1} — story-now, window and
   *   watermark labels, where "Sept 30" against an Oct 2 anchor is a just-past date.
   * - `"forward"`: the first of {Y, Y+1} at or after `notBefore` — a beat's
   *   `afterInWorld` is a not-before date, so a past year is never its intended
   *   reading: "January 15" armed on June 4, 2024 means January 15, 2025, not a
   *   beat due immediately because January 2024 happens to be nearer.
   */
  yearless?: "nearest" | "forward";
  /** Floor for `"forward"` (default: the anchor). The tick's window START is the
   *  natural floor — a beat dated inside the window the tick just simulated has
   *  already landed and is due now, like a just-past date under "nearest". */
  notBefore?: number | null;
}

/**
 * Day parts read as approximate clock times. Scene blocks and scheme-step dates
 * routinely carry a part of the day instead of a clock time ("Saturday,
 * September 13, 2008, late evening").
 * A trailing day part used to be cut off, so the label read as midnight, and a
 * qualified one ("late evening", "early morning", "mid-afternoon") left a stray
 * word that made the whole label unparseable. Each part now maps to one
 * representative hour. Checked in this order, so a qualified form wins over its
 * bare word; a label that also carries a clock time keeps the clock time.
 * "midnight" reads as 12:00 AM of the named date (the literal clock reading).
 */
export const DAY_PART_HOURS: ReadonlyArray<{ parts: string; time: string }> = [
  { parts: "pre-?dawn|before dawn", time: "5:00 AM" },
  { parts: "early morning", time: "6:00 AM" },
  { parts: "dawn|daybreak|sunrise|first light", time: "6:00 AM" },
  { parts: "mid-?morning", time: "10:00 AM" },
  { parts: "late morning", time: "11:00 AM" },
  { parts: "morning", time: "9:00 AM" },
  { parts: "noon|midday|mid-day", time: "12:00 PM" },
  { parts: "early afternoon", time: "1:00 PM" },
  { parts: "mid-?afternoon", time: "3:00 PM" },
  { parts: "late afternoon", time: "5:00 PM" },
  { parts: "afternoon", time: "3:00 PM" },
  { parts: "early evening", time: "6:00 PM" },
  { parts: "dusk|sunset|sundown|twilight|nightfall", time: "7:00 PM" },
  { parts: "late evening", time: "10:00 PM" },
  { parts: "evening", time: "7:00 PM" },
  { parts: "midnight", time: "12:00 AM" },
  { parts: "late night|late at night", time: "11:30 PM" },
  { parts: "night|nighttime|night-time", time: "10:00 PM" },
];
// A clock time already in the label ("11:45 PM", "3 PM", "11:45 p.m.").
const CLOCK_TIME = /\b\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\b\.?|\b\d{1,2}:\d{2}\b/i;

/** Replace the label's day part with its representative clock time, or drop it
 *  when the label already carries a clock time. The part is removed together
 *  with a connector before it ("at", "in the", "on the", a comma), an "early"
 *  / "late" / "mid" left in front of a bare part, and an "of" after it
 *  ("Evening of September 13, 2008"). A label without a day part is returned
 *  as it came. */
function resolveDayPart(label: string): string {
  for (const { parts, time } of DAY_PART_HOURS) {
    const pattern = new RegExp(String.raw`(?:,\s*|\s+|^)(?:(?:at|in the|on the|by|in)\s+)?(?:(?:early|late|mid)[-\s]+)?\b(?:${parts})\b(?:\s+(?:of|on)\b)?(?:\s*,)?`, "i");
    if (!pattern.test(label)) continue;
    const stripped = label.replace(pattern, " ").replace(/\s{2,}/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
    return CLOCK_TIME.test(stripped) ? stripped : `${stripped} ${time}`;
  }
  return label;
}

export function parseInWorldDate(raw: string | null | undefined, anchorEpoch?: number | null, options?: ParseInWorldDateOptions): number | null {
  if (!raw || !raw.trim()) return null;
  const cleaned = resolveDayPart(raw.trim()
    .replace(/[~≈]/g, "") // scene times are often approximate ("~5:22 PM")
    // Approximation words appear ANYWHERE in a label, not only at its head — the
    // composer's scene blocks routinely read "Thursday, August 28, 2008 about
    // 11:45 PM", "… approximately 2:38 PM", "… just after 3 PM". Until
    // 2026-09-07 only a LEADING "about" was stripped, so every such label failed
    // to parse: latestSceneDate fell back to the DATE alone (midnight), date-gated
    // beats came due up to a day late, and the world clock's watermark epoch was
    // null on a live campaign.
    .replace(/\b(?:around|about|approximately|approx\.?|circa|roughly|nearly|almost|just (?:after|before|past)|shortly (?:after|before)|a little (?:after|before)|sometime (?:after|before|around))\s+/gi, ""))
    // A leading qualifier left once any day part is resolved ("late September 2008").
    .replace(/^(late|early|mid)\s+/i, "")
    // Three routine English shapes V8 cannot read — an
    // ordinal day ("August 28th"), an "at" before the clock time ("… 2008 at
    // 11:45 PM") and a dotted or lowercase meridiem ("11:45 p.m.") — lost the
    // hour or the whole date, silently: story-now fell to the previous scene's
    // date or to midnight, and a beat armed "Aug 30th" was never auto-due.
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1")
    .replace(/\s+at\s+(?=\d)/gi, " ")
    .replace(/\b(\d{1,2}(?::\d{2})?)\s*([ap])\.?\s*m\b\.?/gi, (_match, time: string, meridiem: string) => `${time} ${meridiem.toUpperCase()}M`)
    // A bare-hour clock time ("3 PM") is not a form V8 parses; give it minutes.
    .replace(/\b(\d{1,2})(?!:)\s*(AM|PM)\b/i, "$1:00 $2")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Decide year-lessness BEFORE the first Date.parse: V8 happily parses "Oct 5"
  // (to 2001), so the fallthrough below is never reached for the common form.
  const yearless = !/\b\d{4}\b/.test(cleaned);
  const epoch = parseCleanedDate(cleaned);
  if (epoch == null) return null;
  if (!yearless || anchorEpoch == null || !Number.isFinite(anchorEpoch)) return epoch;
  return options?.yearless === "forward"
    ? reanchorYearForward(epoch, anchorEpoch, options.notBefore ?? anchorEpoch)
    : reanchorYear(epoch, anchorEpoch);
}

const MONTH_NAME_SOURCE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTH_NAME = new RegExp(`\\b${MONTH_NAME_SOURCE}\\b`, "i");
/** "2008-08-28", "06/13/2008", "2008-08"; a clock time uses ":" and never matches. */
const NUMERIC_DATE = /\b\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?\b/;
/** A year-less "Month Day" (either order) — the only form the neutral-year fallback may complete. */
const MONTH_DAY = new RegExp(`(?:\\b${MONTH_NAME_SOURCE}\\.?,?\\s+(?:the\\s+)?\\d{1,2}\\b|\\b\\d{1,2}\\s+(?:of\\s+)?${MONTH_NAME_SOURCE}\\b)`, "i");

/** A label is a calendar date only when a month name comes with a number (a day
 *  or a year) or the label carries a numeric date. Weekday-only, relative and
 *  season/year-only labels ("Thursday", "two days later", "Summer 1998") are not
 *  dates: V8 would still "parse" them (see the file header), so the gate runs
 *  BEFORE any Date.parse. */
function carriesCalendarDate(cleaned: string): boolean {
  return (MONTH_NAME.test(cleaned) && /\d/.test(cleaned)) || NUMERIC_DATE.test(cleaned);
}

function parseCleanedDate(cleaned: string): number | null {
  if (!carriesCalendarDate(cleaned)) return null;
  const parsed = Date.parse(cleaned);
  if (Number.isFinite(parsed)) return parsed;
  // Clock-time tails Date.parse can't stomach — the DATE is what ordering needs.
  const dateOnly = cleaned.replace(/\s+\d{1,2}:\d{2}\s*(AM|PM)?$/i, "").trim();
  if (dateOnly !== cleaned) {
    const parsedDate = Date.parse(dateOnly);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }
  // Last resort for a year-less "Month Day" form V8 could not parse on its own:
  // a neutral year so ordering still works WITHIN a campaign that never uses
  // years. Gated to exactly that form: with any other remainder V8
  // read the appended year alone and answered January 1, 2000.
  if (!/\b\d{4}\b/.test(dateOnly) && MONTH_DAY.test(dateOnly)) {
    const withYear = Date.parse(`${dateOnly}, 2000`);
    return Number.isFinite(withYear) ? withYear : null;
  }
  return null;
}

/** Keep month/day/time, swap the year for whichever of {Y-1, Y, Y+1} (Y = the
 *  anchor's year, process TZ like every parse here) lands nearest the anchor. */
function reanchorYear(epoch: number, anchorEpoch: number): number {
  const anchorYear = new Date(anchorEpoch).getFullYear();
  let best = epoch;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const year of [anchorYear - 1, anchorYear, anchorYear + 1]) {
    const candidate = new Date(epoch);
    candidate.setFullYear(year);
    const distance = Math.abs(candidate.getTime() - anchorEpoch);
    if (distance < bestDistance) { best = candidate.getTime(); bestDistance = distance; }
  }
  return best;
}

/** Keep month/day/time, pick the first of {Y, Y+1} (Y = the anchor's year) that
 *  lands at or after `notBefore` — a not-before date never means a past year.
 *  Both candidates below the floor cannot happen for a floor at or
 *  before the anchor; the later one is returned if it ever does. */
function reanchorYearForward(epoch: number, anchorEpoch: number, notBefore: number): number {
  const anchorYear = new Date(anchorEpoch).getFullYear();
  let latest = epoch;
  for (const year of [anchorYear, anchorYear + 1]) {
    const candidate = new Date(epoch);
    candidate.setFullYear(year);
    latest = candidate.getTime();
    if (latest >= notBefore) return latest;
  }
  return latest;
}

export function parseWorldClock(json: string | null | undefined): WorldClock | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<WorldClock>;
    if (!raw || typeof raw.simulatedThrough !== "string") return null;
    return {
      simulatedThrough: raw.simulatedThrough,
      simulatedThroughEpoch: typeof raw.simulatedThroughEpoch === "number" ? raw.simulatedThroughEpoch : null,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
  } catch { return null; }
}

/** `anchorEpoch`: the clock position the label advances FROM (see parseInWorldDate). */
export function serializeWorldClock(label: string, anchorEpoch?: number | null): string {
  return JSON.stringify({
    simulatedThrough: label,
    simulatedThroughEpoch: parseInWorldDate(label, anchorEpoch),
    updatedAt: new Date().toISOString(),
  } satisfies WorldClock);
}

/** Latest parseable-or-not scene date across messages (newest first wins).
 *  `anchorEpoch` re-anchors a year-less scene date (see parseInWorldDate). */
export function latestSceneDate(messages: Array<{ role: string; sceneData?: string | null }>, anchorEpoch?: number | null): { label: string; epoch: number | null } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant" || !m.sceneData) continue;
    try {
      const scene = JSON.parse(m.sceneData) as { date?: string; time?: string };
      if (scene?.date) {
        const label = scene.time ? `${scene.date} ${scene.time}` : scene.date;
        return { label, epoch: parseInWorldDate(label, anchorEpoch) ?? parseInWorldDate(scene.date, anchorEpoch) };
      }
    } catch { /* keep scanning */ }
  }
  return null;
}
