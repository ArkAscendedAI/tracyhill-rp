import type { LorebookEntry, LorebookExport, LorebookExportEntry, LorebookExportFormat } from "@tracyhill-rp/contracts";

// Exact reverses of the importer's SELECTIVE_LOGIC_MAP / POSITION_MAP
// (lorebookImporter.ts) — keep the two in lockstep so json exports re-import
// losslessly.
const SELECTIVE_LOGIC_REVERSE: Record<string, number> = { and_any: 0, not_all: 1, not_any: 2, and_all: 3 };
const POSITION_REVERSE: Record<string, number> = { before_main: 0, after_main: 1, top: 2, bottom: 3 };

/**
 * Build a lorebook export in the ST World Info envelope ({ entries: { uid: … } }).
 *
 * format "json": round-trippable through the existing importer — carries the
 * native `name` + `knownBy` extras (which the importer passes through) and the
 * real `comment`. caseSensitive/matchWholeWords are emitted explicitly (false
 * included): the importer persists an explicit `false` and keywordActivator
 * defaults an ABSENT matchWholeWords to true, so an unstated value would flip
 * substring-matching entries to whole-word on re-import.
 *
 * format "st": strict SillyTavern mapping — `comment` carries the entry name
 * (ST uses comment as the display title; the importer's deriveName mirrors
 * this), no native extras.
 */
export function buildLorebookExport(entries: LorebookEntry[], format: LorebookExportFormat): LorebookExport {
  const out: Record<string, LorebookExportEntry> = {};
  const exportIds = new Map(entries.map((entry, index) => [entry.id, String(index)]));
  entries.forEach((e, i) => {
    const exported: LorebookExportEntry = {
      uid: i,
      key: e.keys,
      keysecondary: e.keysSecondary,
      comment: format === "st" ? e.name : (e.comment ?? ""),
      content: e.content,
      constant: e.isConstant,
      selective: e.keysSecondary.length > 0,
      selectiveLogic: SELECTIVE_LOGIC_REVERSE[e.selectiveLogic] ?? 0,
      order: e.insertionOrder,
      position: POSITION_REVERSE[e.position] ?? 0,
      disable: !e.isEnabled,
      excludeRecursion: e.excludeRecursion,
      preventRecursion: e.preventRecursion,
      delayUntilRecursion: e.delayUntilRecursion,
      probability: e.probability,
      useProbability: true,
      scanDepth: e.scanDepth,
      sticky: e.sticky,
      cooldown: e.cooldown,
      delay: e.delay,
      group: e.tag ?? "",
      // EFFECTIVE values (the keywordActivator defaults): an entry with no
      // stored match options matches whole words, so it must export `true` —
      // exporting `false` here flipped every default entry to substring
      // matching once the importer started honoring an explicit false.
      caseSensitive: e.matchOptions?.caseSensitive ?? false,
      matchWholeWords: e.matchOptions?.matchWholeWords ?? true,
      addMemo: true,
      displayIndex: i,
    };
    if (format === "json") {
      exported.exportId = String(i);
      exported.compressedRefIds = e.compressedRefIds?.map(id => exportIds.get(id) ?? `unresolved:${id}`) ?? null;
      exported.name = e.name;
      exported.knownBy = e.knownBy;
    }
    out[String(i)] = exported;
  });
  return { entries: out };
}
