import { QueryError } from "../../shared/ui/QueryError";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createLorebookEntryRequestSchema, estimateLorebookTokens, lorebookBulkActionSchema, updateLorebookEntryRequestSchema } from "@tracyhill-rp/contracts";
import { EMBEDDING_MODELS } from "@tracyhill-rp/model-catalog";
import type { CreateLorebookEntryRequest, LorebookBulkAction, LorebookEntry, LorebookEntrySummary, UpdateLorebookEntryRequest } from "@tracyhill-rp/contracts";

import { NumericInput } from "../../shared/ui/NumericInput";

import { useCampaigns } from "../campaigns/useCampaigns";
import { DramatistLogPanel } from "../world/DramatistLogPanel";
import { confirmOffscreen } from "../world/worldApi";
import { describeContractIssues, numberBounds, stringMaxLength } from "./contractBounds";
import { LorebookAdvancedFields, type AdvancedEntryValues } from "./LorebookAdvancedFields";
import { ImportReportNotice } from "./ImportReportNotice";
import { LorebookDeletedList } from "./LorebookDeletedList";
import { LorebookHistory } from "./LorebookHistory";
import { RebuildEmbeddingsDialog } from "./RebuildEmbeddingsDialog";
import { TrackerOwnedNotice } from "./TrackerOwnedNotice";
import { BULK_NONE_IN_LIST, buildEntryPayload, characterCardImportReport, describeRebuildResult, describeShortLoad, effectiveBulkSelection, keysSurviveTextEdit, knownBySurvivesTextEdit, listTextsOf, lorebookImportReport, lorebookFieldLabel, lorebookTagOptions, bulkKeysProblem, makeEditorSeed, planEditorResync, splitKeyList, trackerOwnership, visibleTags, worldMarkerOf, type EditorFieldValues, type EditorSeed, type ImportReport } from "./lorebookPanelUtils";
import { useDebouncedValue } from "./useDebouncedValue";
import {
  getLorebookEntry,
  getLorebookEntrySummaries,
  getLorebookTags,
  createLorebookEntry,
  updateLorebookEntry,
  deleteLorebookEntry,
  bulkLorebookAction,
  importLorebook,
  importCharacterCard,
  exportLorebook,
  getEmbeddingStatus,
  rebuildEmbeddings,
} from "./lorebookApi";
import { Icon } from "../../shared/ui/Icon";
import { Dialog } from "../../shared/ui/Dialog";
import { AutoTextarea } from "../../shared/ui/AutoTextarea";
import "../../styles/feature-lorebook.css";

type LorebookPanelProps = {
  open: boolean;
  isAdmin: boolean;
  onClose: () => void;
};

const TAG_COLORS: Record<string, string> = {
  characters: "var(--accent)",
  locations: "var(--green)",
  factions: "var(--purple)",
  events: "var(--amber)",
  lore: "var(--pink)",
  items: "var(--amber)",
  threads: "var(--danger)",
};

function tagColor(tag: string | null): string {
  if (!tag) return "var(--muted)";
  return TAG_COLORS[tag.toLowerCase()] ?? "var(--muted)";
}

// The editor's dials and text caps come from the contract itself, so a value
// the server would reject cannot be typed, and a full-payload parse before
// Save names the field when one slips through.
const ENTRY_FIELDS = createLorebookEntryRequestSchema.shape;
const DIAL_BOUNDS = {
  insertionOrder: numberBounds(ENTRY_FIELDS.insertionOrder),
  scanDepth: numberBounds(ENTRY_FIELDS.scanDepth),
  probability: numberBounds(ENTRY_FIELDS.probability),
  sticky: numberBounds(ENTRY_FIELDS.sticky),
  cooldown: numberBounds(ENTRY_FIELDS.cooldown),
  delay: numberBounds(ENTRY_FIELDS.delay),
  bulkSticky: numberBounds(lorebookBulkActionSchema.shape.sticky),
};
const CONTENT_FACE_KEY = "lorebook.contentFace";

const TEXT_MAX = {
  name: stringMaxLength(ENTRY_FIELDS.name),
  tag: stringMaxLength(ENTRY_FIELDS.tag),
  content: stringMaxLength(ENTRY_FIELDS.content),
  comment: stringMaxLength(ENTRY_FIELDS.comment),
};

export function LorebookPanel({ open, isAdmin, onClose }: LorebookPanelProps) {
  const queryClient = useQueryClient();
  const campaigns = useCampaigns();
  const [campaignId, setCampaignId] = useState<string | null>(null);
  // "deleted" = Recently deleted: the campaign's deleted entries, each restorable.
  const [panelView, setPanelView] = useState<"lorebook" | "deleted" | "dramatist">("lorebook");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("");
  // Living World — offscreen filter facet ("" | "offscreen" | "provisional")
  const [worldFacet, setWorldFacet] = useState<"" | "offscreen" | "provisional">("");
  const [spoilerRevealed, setSpoilerRevealed] = useState(false);
  const [sortField, setSortField] = useState<string>("updated_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState(false);
  // Bulk quick-wins, which replace the SQL-on-prod curation pattern.
  const [bulkKeys, setBulkKeys] = useState("");
  const [bulkSticky, setBulkSticky] = useState(0);
  const [showImport, setShowImport] = useState(false);
  // "Rebuild Embeddings" opens a choice first (stale and missing only, or all).
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Content face (2026-09-24, against walls of text spread too wide): prose = the
  // transcript's sans face at reading size on a capped measure; mono = the old fixed-width
  // view. Persisted per browser.
  const [contentFace, setContentFace] = useState<"prose" | "mono">(() => {
    try { return localStorage.getItem(CONTENT_FACE_KEY) === "mono" ? "mono" : "prose"; } catch { return "prose"; }
  });
  const chooseContentFace = (face: "prose" | "mono") => { setContentFace(face); try { localStorage.setItem(CONTENT_FACE_KEY, face); } catch { /* private mode */ } };
  const [error, setError] = useState("");

  // Editor state
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editTag, setEditTag] = useState("");
  const [editKeys, setEditKeys] = useState("");
  const [editKeysSecondary, setEditKeysSecondary] = useState("");
  const [editComment, setEditComment] = useState("");
  const [editPosition, setEditPosition] = useState("before_main");
  const [editInsertionOrder, setEditInsertionOrder] = useState(100);
  const [editScanDepth, setEditScanDepth] = useState(4);
  const [editSelectiveLogic, setEditSelectiveLogic] = useState("and_any");
  const [editProbability, setEditProbability] = useState(100);
  const [editIsConstant, setEditIsConstant] = useState(false);
  const [editIsEnabled, setEditIsEnabled] = useState(true);
  const [editSticky, setEditSticky] = useState(0);
  const [editCooldown, setEditCooldown] = useState(0);
  const [editDelay, setEditDelay] = useState(0);
  const [editExcludeRecursion, setEditExcludeRecursion] = useState(false);
  const [editPreventRecursion, setEditPreventRecursion] = useState(false);
  const [editDelayUntilRecursion, setEditDelayUntilRecursion] = useState(false);
  const [editKnownBy, setEditKnownBy] = useState("");
  const [creating, setCreating] = useState(false);
  const [detailTab, setDetailTab] = useState<"editor" | "history">("editor");
  const [info, setInfo] = useState<string | null>(null);
  // The last import's result with its full error/warning list.
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  // Two-step delete confirmations (project rule: in-app confirmation for
  // destructive actions — these were single-click).
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [dirty, setDirty] = useState(false);
  // In-app unsaved-changes guard. Holds the navigation/filter action the
  // user triggered while the editor is dirty; confirming discards the edits (the
  // fields go back to the saved row, or clear for a new entry) and runs it,
  // cancelling keeps the editor mounted with the unsaved edits intact.
  const [pendingNav, setPendingNav] = useState<{ run: () => void } | null>(null);
  // The list row the editor fields were seeded from — drives the resync
  // when that row changes underneath the open editor.
  const [editorSeed, setEditorSeed] = useState<EditorSeed | null>(null);
  const [serverChanged, setServerChanged] = useState(false);
  // Trailing debounce so typing does not refetch the full paged lorebook
  // per keystroke.
  const searchKey = useDebouncedValue(searchQuery.trim(), 250);

  // Run `action` immediately unless the editor has unsaved edits, in which case
  // stash it behind the confirm dialog.
  const guardDirty = (action: () => void) => {
    if (dirty) { setPendingNav({ run: action }); return; }
    action();
  };

  // Status/rebuild must target the CAMPAIGN's embedding model — the server's
  // fallback is the catalog default, which may not be this campaign's, so the
  // status counted the wrong vector namespace and a rebuild spent paid API
  // embedding into a model the campaign doesn't retrieve with.
  const selectedCampaign = campaigns.data?.campaigns.find((c) => c.id === campaignId);
  const campaignName = selectedCampaign?.name ?? "this campaign";
  const campaignEmbeddingModel = ((): string | undefined => {
    const model = selectedCampaign?.embeddingModel;
    return typeof model === "string" && model ? model : undefined;
  })();

  const entries = useQuery({
    queryKey: ["lorebook-entries", campaignId, tagFilter, searchKey, sortField, sortOrder, worldFacet],
    // Summaries: every field but the text, so a filter change no longer downloads every
    // entry's content; the selected entry's full row is fetched on its own below.
    queryFn: () => campaignId ? getLorebookEntrySummaries(campaignId, { tag: tagFilter || undefined, search: searchKey || undefined, sort: sortField, order: sortOrder, offscreen: worldFacet === "offscreen" || undefined, provisional: worldFacet === "provisional" || undefined }) : Promise.resolve({ entries: [] as LorebookEntrySummary[], total: 0 }),
    // Gated on `open` too: this panel is mounted with the app shell, so every
    // page load used to fetch the full Mara lorebook for a closed dialog.
    enabled: Boolean(campaignId) && open,
    // Keep the previous page while a new search/filter key loads — the list
    // used to flash empty and unmount the open editor mid-keystroke.
    placeholderData: (prev, query) => query?.queryKey[1] === campaignId ? prev : undefined,
  });

  const tags = useQuery({
    queryKey: ["lorebook-tags", campaignId],
    queryFn: () => campaignId ? getLorebookTags(campaignId) : Promise.resolve({ tags: [] }),
    enabled: Boolean(campaignId) && open,
  });

  const embeddingStatus = useQuery({
    queryKey: ["embedding-status", campaignId, campaignEmbeddingModel ?? "default"],
    queryFn: () => campaignId ? getEmbeddingStatus(campaignId, campaignEmbeddingModel) : Promise.resolve({ totalEntries: 0, indexed: 0, stale: 0, missing: 0, model: "" }),
    enabled: Boolean(campaignId) && open,
  });

  // Every mutation carries the campaign it targeted and invalidates THAT
  // campaign's queries: reading `campaignId` when the response lands picked up
  // whatever campaign was selected by then, so a request that settled after a
  // switch left the campaign it changed with a stale cached list.
  const invalidateCampaign = (target: string) => {
    queryClient.invalidateQueries({ queryKey: ["lorebook-entries", target] });
    queryClient.invalidateQueries({ queryKey: ["lorebook-tags", target] });
    // The dropdown's "(N)" counts come from the campaign list and the footer's
    // "indexed/total" from the embedding status — both changed by every write
    // here and neither was refreshed until an unrelated refetch.
    queryClient.invalidateQueries({ queryKey: ["embedding-status", target] });
    queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    // A delete adds to Recently deleted and a restore takes from it.
    queryClient.invalidateQueries({ queryKey: ["lorebook-deleted", target] });
  };

  const createMutation = useMutation({
    mutationFn: ({ campaignId: target, payload }: { campaignId: string; payload: CreateLorebookEntryRequest }) => createLorebookEntry(target, payload),
    onSuccess: (_created, vars) => { invalidateCampaign(vars.campaignId); setCreating(false); resetEditor(); },
    onError: (e) => setError(e instanceof Error ? e.message : "create failed"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ entryId, payload }: { campaignId: string; entryId: string; payload: UpdateLorebookEntryRequest }) => updateLorebookEntry(entryId, payload),
    onSuccess: (saved, vars) => {
      invalidateCampaign(vars.campaignId);
      // The list refetch shows this row's new updatedAt; the full row it keys is this one.
      queryClient.setQueryData(["lorebook-entry", saved.id, saved.updatedAt], saved);
      if (vars.entryId !== selectedEntryId) return;
      // The response is the row the list refetch will carry. Seeding the resync
      // from it means the user's OWN save never reads as "changed on the server".
      // If nothing was typed while the request was in flight the
      // fields adopt the saved row (trimmed as stored) and go clean; keystrokes
      // typed meanwhile stay as dirty edits on top of the new seed.
      if (JSON.stringify(vars.payload) === JSON.stringify(buildUpdatePayload())) {
        seedEditorFields(saved);
      } else {
        setEditorSeed(makeEditorSeed(saved));
        setServerChanged(false);
      }
    },
    onError: (e) => setError(e instanceof Error ? e.message : "update failed"),
  });

  // "Confirm as canon" goes through the server-side marker writer
  // and is its OWN mutation: routing it through updateMutation cleared the
  // dirty flag while other unsaved edits remained. The editor's
  // comment field refreshes from the reloaded entry via the resync effect.
  const confirmMutation = useMutation({
    mutationFn: ({ campaignId: target, entryId }: { campaignId: string; entryId: string }) => confirmOffscreen(target, entryId),
    onSuccess: (_result, vars) => { invalidateCampaign(vars.campaignId); setInfo("Confirmed as on-page canon."); },
    onError: (e) => setError(e instanceof Error ? e.message : "confirm failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ entryId }: { campaignId: string; entryId: string }) => deleteLorebookEntry(entryId),
    onSuccess: (_result, vars) => { invalidateCampaign(vars.campaignId); setSelectedEntryId(null); resetEditor(); },
    onError: (e) => setError(e instanceof Error ? e.message : "delete failed"),
  });

  const bulkMutation = useMutation({
    mutationFn: ({ campaignId: target, payload }: { campaignId: string; payload: LorebookBulkAction }) => bulkLorebookAction(target, payload),
    onSuccess: (result, vars) => {
      invalidateCampaign(vars.campaignId);
      setSelectedIds(new Set());
      setBulkMode(false);
      // "+ Keys" keeps its keys until the append is done; a refused or failed one leaves them to correct or resend.
      if (vars.payload.action === "append_keys") setBulkKeys("");
      // What the verb could NOT do (additive `warnings`:
      // append_keys stops at the 100-key cap) is shown, never swallowed.
      if (result.warnings?.length) setInfo(result.warnings.join(" · "));
    },
    onError: (e) => setError(e instanceof Error ? e.message : "bulk action failed"),
  });

  const importMutation = useMutation({
    mutationFn: ({ campaignId: target, data }: { campaignId: string; data: unknown }) => importLorebook(target, data),
    onSuccess: (result, vars) => {
      invalidateCampaign(vars.campaignId);
      setShowImport(false);
      setImportReport(lorebookImportReport(result));
    },
    onError: (e) => setError(e instanceof Error ? e.message : "import failed"),
  });

  // The campaign, its model and the choice are pinned at click time: the
  // dropdown may change while a full rebuild runs, and the result names its campaign.
  const rebuildMutation = useMutation({
    mutationFn: ({ campaignId: target, model, staleOnly }: { campaignId: string; campaignName: string; model: string | undefined; staleOnly: boolean }) => rebuildEmbeddings(target, model, { staleOnly }),
    onSuccess: (result, vars) => {
      queryClient.invalidateQueries({ queryKey: ["embedding-status", vars.campaignId] });
      setRebuildOpen(false);
      setInfo(describeRebuildResult(result, vars.staleOnly, vars.campaignName));
    },
    onError: (e) => { setRebuildOpen(false); setError(e instanceof Error ? e.message : "rebuild failed"); },
  });

  // SillyTavern character-card import (.png V2/V3 or .json) — additive + collision-safe.
  const cardMutation = useMutation({
    mutationFn: ({ campaignId: target, body }: { campaignId: string; body: { card?: unknown; pngBase64?: string } }) => importCharacterCard(target, body),
    onSuccess: (r, vars) => {
      invalidateCampaign(vars.campaignId);
      setImportReport(characterCardImportReport(r));
    },
    onError: (e) => setError(e instanceof Error ? e.message : "card import failed"),
  });
  const handleImportCard = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !campaignId) return;
    // The campaign is pinned at pick time: the read is asynchronous and the
    // dropdown may change before it completes.
    const target = campaignId;
    const reader = new FileReader();
    if (file.name.toLowerCase().endsWith(".png")) {
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        cardMutation.mutate({ campaignId: target, body: { pngBase64: b64 } });
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => {
        try { cardMutation.mutate({ campaignId: target, body: { card: JSON.parse(String(reader.result)) } }); }
        catch { setError("could not parse the card JSON"); }
      };
      reader.readAsText(file);
    }
  };

  useEffect(() => { setConfirmDeleteEntry(false); }, [selectedEntryId]);
  useEffect(() => { setConfirmBulkDelete(false); }, [selectedIds]);

  const entryList = entries.data?.entries ?? [];
  // A paged load that ended short of the route's total is reported, never silent.
  const shortLoad = entries.data ? describeShortLoad(entries.data.entries.length, entries.data.total) : null;

  // The list holds summaries; the editor reads the selected entry's full row, fetched on
  // selection and again whenever the list shows a newer `updatedAt` for it. An entry the list no
  // longer holds (filtered out, deleted) closes the editor, as it did when the list had the text.
  const selectedSummary = useMemo(() => entryList.find(e => e.id === selectedEntryId) ?? null, [entryList, selectedEntryId]);
  const selectedEntryQuery = useQuery({
    queryKey: ["lorebook-entry", selectedEntryId, selectedSummary?.updatedAt ?? null],
    queryFn: () => getLorebookEntry(selectedEntryId!),
    enabled: Boolean(selectedSummary) && open,
    // While a newer version of the same entry loads, keep the one on screen.
    placeholderData: (prev) => (prev && prev.id === selectedEntryId ? prev : undefined),
  });
  const selectedEntry = selectedSummary && selectedEntryQuery.data?.id === selectedEntryId ? selectedEntryQuery.data : null;
  // The fields show once they hold this entry (the resync effect seeds a new selection on arrival).
  const editorReady = Boolean(selectedEntry && editorSeed?.id === selectedEntry.id);
  // One JSON.parse per entry per list change, not three per row per render.
  const markers = useMemo(() => new Map(entryList.map(e => [e.id, worldMarkerOf(e.comment)])), [entryList]);
  const selectedMarker = selectedEntry ? (markers.get(selectedEntry.id) ?? worldMarkerOf(selectedEntry.comment)) : null;
  // The thread tracker owns the Thread Index and every `threads` entry, so the
  // editor shows them read-only. Decided from the stored row, never from the edited fields.
  const trackerKind = selectedEntry && !creating ? trackerOwnership(selectedEntry) : null;
  const readOnly = trackerKind !== null;
  // While Create runs the fields are read-only (Android's rule too): its success closes and blanks the editor,
  // so a keystroke typed meanwhile was dropped. A failed Create hands the form back. Save keeps its own rule.
  const fieldsLocked = readOnly || createMutation.isPending;
  // What a bulk action acts on: the ticked rows that are IN the list on
  // screen. Ids the current filter hides are shown as such and never posted;
  // a campaign switch and Cancel clear the selection outright.
  const bulkSelection = useMemo(() => effectiveBulkSelection(selectedIds, entryList), [selectedIds, entryList]);

  // Auto-select first campaign that has lorebook entries
  useEffect(() => {
    if (!campaignId && campaigns.data?.campaigns.length) {
      const withEntries = campaigns.data.campaigns.find(c => (c.lorebookEntryCount ?? 0) > 0) ?? campaigns.data.campaigns[0];
      if (withEntries) setCampaignId(withEntries.id);
    }
  }, [campaignId, campaigns.data]);

  // Field seeding shared by the click handler and the resync effect below —
  // the effect must NOT bounce the user off the History tab or re-blur a
  // revealed spoiler, so tab/reveal state stays in selectEntry.
  const seedEditorFields = (entry: LorebookEntry) => {
    setEditName(entry.name);
    setEditContent(entry.content);
    setEditTag(entry.tag ?? "");
    // The same text the seed records, so an untouched list is left out of the update.
    const listTexts = listTextsOf(entry);
    setEditKeys(listTexts.keys);
    setEditKeysSecondary(listTexts.keysSecondary);
    setEditComment(entry.comment ?? "");
    setEditPosition(entry.position);
    setEditInsertionOrder(entry.insertionOrder);
    setEditScanDepth(entry.scanDepth);
    setEditSelectiveLogic(entry.selectiveLogic);
    setEditProbability(entry.probability);
    setEditIsConstant(entry.isConstant);
    setEditIsEnabled(entry.isEnabled);
    setEditSticky(entry.sticky);
    setEditCooldown(entry.cooldown);
    setEditDelay(entry.delay);
    setEditExcludeRecursion(entry.excludeRecursion);
    setEditPreventRecursion(entry.preventRecursion);
    setEditDelayUntilRecursion(entry.delayUntilRecursion);
    setEditKnownBy(listTexts.knownBy);
    setDirty(false);
    setServerChanged(false);
    setEditorSeed(makeEditorSeed(entry));
  };

  const selectEntry = (entry: LorebookEntrySummary) => {
    setSelectedEntryId(entry.id);
    setCreating(false);
    setDetailTab("editor");
    setSpoilerRevealed(false);
    setShowAdvanced(false);
    setError("");
    // A list row has no text. A newly selected entry seeds when its full row arrives (the
    // resync effect's "seed"); the entry already open reseeds from the row on screen, as before.
    if (selectedEntry && entry.id === selectedEntry.id) seedEditorFields(selectedEntry);
  };

  // Seed the editor when a selected entry's full row arrives, and re-sync it when that row
  // changes underneath it: a History-tab revert, Confirm-as-canon, or a worker rewrite.
  useEffect(() => {
    const plan = planEditorResync(editorSeed, selectedEntry, dirty, editComment);
    if (plan === "none" || !selectedEntry) return;
    if (plan === "seed" || plan === "reseed") { seedEditorFields(selectedEntry); return; }
    if (plan === "comment-only") {
      setEditComment(selectedEntry.comment ?? "");
      setEditorSeed(makeEditorSeed(selectedEntry));
      return;
    }
    setServerChanged(true);
  }, [selectedEntry?.id, selectedEntry?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetEditor = () => {
    setEditName(""); setEditContent(""); setEditTag(""); setEditKeys(""); setEditKeysSecondary("");
    setEditComment(""); setEditPosition("before_main"); setEditInsertionOrder(100); setEditScanDepth(4);
    setEditSelectiveLogic("and_any"); setEditProbability(100); setEditIsConstant(false); setEditIsEnabled(true);
    setEditSticky(0); setEditCooldown(0); setEditDelay(0); setEditExcludeRecursion(false);
    setEditPreventRecursion(false); setEditDelayUntilRecursion(false); setEditKnownBy(""); setShowAdvanced(false); setDirty(false);
    setEditorSeed(null); setServerChanged(false);
  };

  const startCreate = () => {
    setSelectedEntryId(null);
    setCreating(true);
    setDetailTab("editor");
    resetEditor();
    setError("");
  };

  // `editPosition` has no control: it is seeded from the row and sent back as is.
  const editorFields = (): EditorFieldValues => ({
    name: editName, content: editContent, tag: editTag, comment: editComment, keys: editKeys, keysSecondary: editKeysSecondary,
    position: editPosition, insertionOrder: editInsertionOrder, scanDepth: editScanDepth, selectiveLogic: editSelectiveLogic,
    probability: editProbability, isConstant: editIsConstant, isEnabled: editIsEnabled, sticky: editSticky, cooldown: editCooldown,
    delay: editDelay, excludeRecursion: editExcludeRecursion, preventRecursion: editPreventRecursion,
    delayUntilRecursion: editDelayUntilRecursion, knownBy: editKnownBy,
  });
  const buildPayload = () => buildEntryPayload(editorFields());
  // An update leaves out each list whose text is still the text it was seeded with, so an untouched Save cannot
  // re-split a stored key or known-by name.
  const buildUpdatePayload = () => buildEntryPayload(editorFields(), editorSeed?.id === selectedEntryId ? editorSeed : null);

  const advancedValues: AdvancedEntryValues = {
    insertionOrder: editInsertionOrder, scanDepth: editScanDepth, selectiveLogic: editSelectiveLogic, probability: editProbability,
    sticky: editSticky, cooldown: editCooldown, delay: editDelay, excludeRecursion: editExcludeRecursion,
    preventRecursion: editPreventRecursion, delayUntilRecursion: editDelayUntilRecursion,
  };
  const changeAdvanced = (patch: Partial<AdvancedEntryValues>) => {
    if (patch.insertionOrder !== undefined) setEditInsertionOrder(patch.insertionOrder);
    if (patch.scanDepth !== undefined) setEditScanDepth(patch.scanDepth);
    if (patch.selectiveLogic !== undefined) setEditSelectiveLogic(patch.selectiveLogic);
    if (patch.probability !== undefined) setEditProbability(patch.probability);
    if (patch.sticky !== undefined) setEditSticky(patch.sticky);
    if (patch.cooldown !== undefined) setEditCooldown(patch.cooldown);
    if (patch.delay !== undefined) setEditDelay(patch.delay);
    if (patch.excludeRecursion !== undefined) setEditExcludeRecursion(patch.excludeRecursion);
    if (patch.preventRecursion !== undefined) setEditPreventRecursion(patch.preventRecursion);
    if (patch.delayUntilRecursion !== undefined) setEditDelayUntilRecursion(patch.delayUntilRecursion);
    setDirty(true);
  };

  const saveEntry = () => {
    if (!editName.trim() || !editContent.trim() || !campaignId) return;
    if (creating) {
      const payload = buildPayload();
      const parsed = createLorebookEntryRequestSchema.safeParse(payload);
      if (!parsed.success) { setError(describeContractIssues(parsed.error.issues, lorebookFieldLabel)); return; }
      setError("");
      createMutation.mutate({ campaignId, payload });
    } else if (selectedEntryId) {
      const payload = buildUpdatePayload();
      const parsed = updateLorebookEntryRequestSchema.safeParse(payload);
      if (!parsed.success) { setError(describeContractIssues(parsed.error.issues, lorebookFieldLabel)); return; }
      setError("");
      updateMutation.mutate({ campaignId, entryId: selectedEntryId, payload });
    }
  };

  // Runs a bulk verb over the on-screen selection only; an empty intersection
  // is reported instead of posting ids from another list.
  const runBulk = (action: Omit<LorebookBulkAction, "entryIds">) => {
    if (!campaignId) return;
    if (bulkSelection.ids.length === 0) { setError(BULK_NONE_IN_LIST); return; }
    // The next result replaces an earlier failure, as a save's does.
    setError("");
    bulkMutation.mutate({ campaignId, payload: { entryIds: bulkSelection.ids, ...action } });
  };

  const exitBulkMode = () => { setBulkMode(false); setSelectedIds(new Set()); };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !campaignId) return;
    const target = campaignId;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        importMutation.mutate({ campaignId: target, data });
      } catch {
        setError("invalid JSON file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleExport = async () => {
    if (!campaignId || exporting) return;
    setExporting(true);
    try {
      const data = await exportLorebook(campaignId, "json");
      const campaignName = campaigns.data?.campaigns.find(c => c.id === campaignId)?.name ?? campaignId;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lorebook-${campaignName.replace(/[^\w-]+/g, "_")}.json`;
      // Append + defer the revoke: revoking in the click's own tick without
      // the anchor in the document intermittently aborts the download in
      // Firefox on large exports.
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "export failed");
    } finally {
      setExporting(false);
    }
  };

  const toggleBulkSelect = (entryId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  // A stored list the text box cannot show exactly (a key or name holding a comma, or a slash the text makes
  // read as a regex) keeps its stored form on Save while its field is untouched; say so, since an edit re-splits
  // the whole field.
  const listNoteFor = (field: "keys" | "keysSecondary" | "knownBy") => {
    if (!selectedEntry || creating || readOnly) return null;
    const exact = field === "knownBy" ? knownBySurvivesTextEdit(selectedEntry.knownBy) : keysSurviveTextEdit(selectedEntry[field]);
    if (exact) return null;
    return (
      <span className="lorebook-field-note" role="note">
        {field === "knownBy"
          ? "A stored name contains a comma, so this box cannot show the names exactly. Save leaves them as stored unless you edit this field; an edited field is saved split at its commas."
          : "A stored key contains a comma or slash, so this box cannot show the keys exactly. Save leaves them as stored unless you edit this field; an edited field is saved split at its commas."}
      </span>
    );
  };

  const busy = createMutation.isPending || updateMutation.isPending || confirmMutation.isPending || deleteMutation.isPending || bulkMutation.isPending || importMutation.isPending;

  const totalTokens = entryList.reduce((sum, e) => sum + e.tokensEstimate, 0);
  const enabledCount = entryList.filter(e => e.isEnabled).length;
  const constantCount = entryList.filter(e => e.isConstant).length;

  if (!open) return null;

  return (
    <Dialog open onClose={onClose} label="Lorebook" size="panel" className="lorebook-dialog" bodyClassName="dialog-body-flush" hideClose>
        {/* Topbar */}
        <div className="cc-topbar">
          <Icon name="book-open" size={16} />
          <button type="button" className={panelView === "lorebook" ? "secondary-button" : "ghost-button"} onClick={() => guardDirty(() => setPanelView("lorebook"))}>Lorebook</button>
          <button type="button" className={panelView === "deleted" ? "secondary-button" : "ghost-button"} onClick={() => guardDirty(() => setPanelView("deleted"))} disabled={!campaignId} title="Entries deleted from this campaign; any of them can be restored">
            <Icon name="archive-restore" size={13} /> Recently deleted
          </button>
          {isAdmin && <button type="button" className={panelView === "dramatist" ? "secondary-button" : "ghost-button"} onClick={() => guardDirty(() => setPanelView("dramatist"))}>Behind the Curtain</button>}
          <select
            value={campaignId ?? ""}
            onChange={e => { const next = e.target.value; if (!next) return; guardDirty(() => { setCampaignId(next); setSelectedEntryId(null); resetEditor(); setCreating(false); exitBulkMode(); }); }}
            style={{ flex: 1, minWidth: 0, fontSize: 12 }}
          >
            {/* Placeholder only (shown until the auto-select below picks a campaign, or
                when there are none): choosing it used to discard the editor and snap
                straight back to the first campaign. */}
            <option value="" disabled>Select campaign…</option>
            {campaigns.data?.campaigns.map(c => <option key={c.id} value={c.id}>{c.name} ({c.lorebookEntryCount ?? 0})</option>)}
          </select>
          <span className="muted" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
            {entryList.length} entries &middot; ~{(totalTokens / 1000).toFixed(1)}k tok
          </span>
          <button type="button" className="ghost-button" onClick={onClose} title="Close"><Icon name="x" size={16} /></button>
        </div>

        {error && <div className="lorebook-error" onClick={() => setError("")}>{error}</div>}
        {info && <div className="lorebook-info" onClick={() => setInfo(null)}>{info}</div>}
        {importReport && <ImportReportNotice report={importReport} onDismiss={() => setImportReport(null)} />}

        {panelView === "dramatist" && isAdmin ? (
          <DramatistLogPanel campaignId={campaignId} enabled={open} />
        ) : panelView === "deleted" && campaignId ? (
          <LorebookDeletedList
            campaignId={campaignId}
            campaignName={campaignName}
            onRestored={(entry, target) => { invalidateCampaign(target); setInfo(`Restored ${entry.name}. It is back in the list.`); }}
          />
        ) : (
        <div className="lorebook-body">
          {/* Left: Entry List */}
          <div className="lorebook-list-panel">
            <div className="lorebook-list-toolbar">
              <input
                type="text"
                placeholder="Search entries..."
                value={searchQuery}
                onChange={e => { const next = e.target.value; guardDirty(() => setSearchQuery(next)); }}
                className="lorebook-search"
              />
              <select value={tagFilter} onChange={e => { const next = e.target.value; guardDirty(() => setTagFilter(next)); }} className="lorebook-tag-filter">
                <option value="">All tags</option>
                {lorebookTagOptions(tags.data?.tags, tagFilter).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="lorebook-facet-row">
              {([["", "All"], ["offscreen", "Offscreen"], ["provisional", "Provisional"]] as const).map(([value, label]) => (
                <button
                  key={value || "all"}
                  type="button"
                  className={`lorebook-facet-pill${worldFacet === value ? " active" : ""}`}
                  onClick={() => guardDirty(() => setWorldFacet(value))}
                  title={value === "offscreen" ? "Events created by the world tick (hidden world state)" : value === "provisional" ? "Offscreen events not yet confirmed on the page" : "All entries"}
                >
                  {value ? <><Icon name="moon" size={12} /> {label}</> : label}
                </button>
              ))}
            </div>
            <div className="lorebook-list-actions">
              <button type="button" className="ghost-button" onClick={() => guardDirty(startCreate)} disabled={!campaignId}>+ New</button>
              <button type="button" className="ghost-button" onClick={() => bulkMode ? exitBulkMode() : setBulkMode(true)}>
                {bulkMode ? "Cancel" : "Select"}
              </button>
              <button type="button" className="ghost-button" onClick={() => setShowImport(true)} disabled={!campaignId}>Import</button>
              <label className={`ghost-button${!campaignId || cardMutation.isPending ? " disabled" : ""}`} style={{ cursor: campaignId ? "pointer" : "default" }} title="Import a SillyTavern character card (.png or .json) — adds a character entry + its embedded lorebook, never overwrites existing entries">
                {cardMutation.isPending ? "Importing…" : "Import Card"}
                <input type="file" accept=".png,.json,application/json,image/png" style={{ display: "none" }} disabled={!campaignId || cardMutation.isPending} onChange={handleImportCard} />
              </label>
              <button type="button" className="ghost-button" onClick={handleExport} disabled={!campaignId || exporting} title="Download this campaign's lorebook as JSON (re-importable)">
                {exporting ? "Exporting..." : "Export"}
              </button>
              <div style={{ flex: 1 }} />
              <select value={sortField} onChange={e => setSortField(e.target.value)} style={{ fontSize: 10, padding: "2px 4px", width: "auto" }}>
                <option value="updated_at">Recent</option>
                <option value="name">Name</option>
                <option value="tag">Tag</option>
                <option value="insertion_order">Order</option>
              </select>
              <button type="button" className="ghost-button" onClick={() => setSortOrder(o => o === "asc" ? "desc" : "asc")} style={{ fontSize: 10, padding: "2px" }}>
                {sortOrder === "asc" ? "↑" : "↓"}
              </button>
            </div>

            {bulkMode && selectedIds.size > 0 && (
              <div className="lorebook-bulk-bar">
                <span className="muted" style={{ fontSize: 11 }} title={bulkSelection.hidden > 0 ? "Selected entries that the current search/filter hides are not included in a bulk action" : undefined}>
                  {bulkSelection.ids.length} selected{bulkSelection.hidden > 0 ? ` (+${bulkSelection.hidden} not in this list)` : ""}
                </span>
                <button type="button" className="ghost-button" onClick={() => runBulk({ action: "enable" })} disabled={busy || bulkSelection.ids.length === 0}>Enable</button>
                <button type="button" className="ghost-button" onClick={() => runBulk({ action: "disable" })} disabled={busy || bulkSelection.ids.length === 0}>Disable</button>
                {confirmBulkDelete ? (
                  <>
                    <button type="button" className="ghost-button danger-text" onClick={() => { runBulk({ action: "delete" }); setConfirmBulkDelete(false); }} disabled={busy || bulkSelection.ids.length === 0}>
                      Confirm: delete {bulkSelection.ids.length} from {campaignName}
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setConfirmBulkDelete(false)}>Cancel</button>
                  </>
                ) : (
                  <button type="button" className="ghost-button danger-text" onClick={() => setConfirmBulkDelete(true)} disabled={busy || bulkSelection.ids.length === 0}>Delete</button>
                )}
              </div>
            )}

            {bulkMode && selectedIds.size > 0 && (
              <div className="lorebook-bulk-bar">
                <input
                  type="text"
                  placeholder="keys to append, comma-separated"
                  value={bulkKeys}
                  onChange={e => setBulkKeys(e.target.value)}
                  readOnly={bulkMutation.isPending}
                  style={{ flex: 1, minWidth: 0, fontSize: 11 }}
                  title="Append these keys to every selected entry (deduped)"
                />
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    const keys = splitKeyList(bulkKeys);
                    // Named here, with the keys left in the field, instead of the route's bare 400.
                    const problem = bulkKeysProblem(keys);
                    if (problem) { setError(problem); return; }
                    if (keys.length) runBulk({ action: "append_keys", keys });
                  }}
                  disabled={busy || splitKeyList(bulkKeys).length === 0 || bulkSelection.ids.length === 0}
                >
                  + Keys
                </button>
                <NumericInput value={bulkSticky} onChange={setBulkSticky} {...DIAL_BOUNDS.bulkSticky} style={{ width: 52, fontSize: 11 }} />
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => runBulk({ action: "set_sticky", sticky: bulkSticky })}
                  disabled={busy || bulkSelection.ids.length === 0}
                  title="Set sticky turns on every selected entry"
                >
                  Set sticky
                </button>
              </div>
            )}

            <div className="lorebook-entries-list">
              <QueryError query={entries} label="Unable to load lorebook entries" />
              {shortLoad && (
                <div className="lorebook-short-load" role="status">
                  <span>{shortLoad}</span>
                  <button type="button" className="ghost-button" onClick={() => void entries.refetch()} disabled={entries.isFetching}>{entries.isFetching ? "Reloading…" : "Reload"}</button>
                </div>
              )}
              {entries.isLoading && <p className="muted small-copy" style={{ padding: 8 }}>Loading...</p>}
              {entryList.map(entry => {
                const marker = markers.get(entry.id) ?? null;
                return (
                <div
                  key={entry.id}
                  className={`lorebook-entry-item${entry.id === selectedEntryId ? " active" : ""}${!entry.isEnabled ? " disabled-entry" : ""}`}
                  onClick={() => bulkMode ? toggleBulkSelect(entry.id) : guardDirty(() => selectEntry(entry))}
                >
                  {bulkMode && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(entry.id)}
                      onChange={() => toggleBulkSelect(entry.id)}
                      onClick={e => e.stopPropagation()}
                      style={{ marginRight: 6 }}
                    />
                  )}
                  <div className="lorebook-entry-info">
                    <span className="lorebook-entry-name">{entry.name}</span>
                    <span className="lorebook-entry-meta">
                      {entry.tag && <span className="lorebook-tag-badge" style={{ color: tagColor(entry.tag) }}>{entry.tag}</span>}
                      <span className="muted">{entry.tokensEstimate}t</span>
                      {entry.knownBy && entry.knownBy.length > 0 && <span className="lorebook-scoped-badge" title={`Known by: ${entry.knownBy.join(", ")}`}>scoped</span>}
                      {marker && <span className="lorebook-offscreen-badge" title={marker.provisional ? "Offscreen (provisional — not yet confirmed on the page)" : "Offscreen event"}><Icon name="moon" size={11} />{marker.provisional ? "?" : ""}</span>}
                      {entry.isConstant && <span className="lorebook-const-badge">const</span>}
                      {entry.compressedRefIds && entry.compressedRefIds.length > 0 && <span className="lorebook-archived-badge" title={`Compressed trigger for ${entry.compressedRefIds.length} cold entries`}>archived</span>}
                      {!entry.isEnabled && <span className="lorebook-off-badge">off</span>}
                    </span>
                  </div>
                </div>
                );
              })}
              {entries.isSuccess && entryList.length === 0 && campaignId && (
                <div className="panel-empty-state"><img className="empty-state-art empty-state-art-md" src="/brand/empty-lorebook.webp" alt="" width="720" height="720" loading="lazy" /><p className="muted small-copy">No entries. Click "+ New" or "Import" to add lorebook entries.</p></div>
              )}
              {!campaignId && (
                <p className="muted small-copy" style={{ padding: 12 }}>Select a campaign to view its lorebook.</p>
              )}
            </div>

            {/* Stats footer */}
            <div className="lorebook-stats">
              <span>{enabledCount}/{entryList.length} enabled</span>
              <span>{constantCount} const</span>
              {embeddingStatus.data && embeddingStatus.data.totalEntries > 0 && (
                <span title={`${embeddingStatus.data.indexed} indexed, ${embeddingStatus.data.missing} missing, ${embeddingStatus.data.stale} stale`}>
                  {embeddingStatus.data.indexed}/{embeddingStatus.data.totalEntries} embedded
                </span>
              )}
            </div>
          </div>

          {/* Right: Entry Editor */}
          <div className="lorebook-editor-panel">
            {(editorReady || creating) ? (
              <>
                {selectedEntry && !creating && (
                  <div className="lorebook-detail-tabs row gap-sm" style={{ marginBottom: 8 }}>
                    <button type="button" className={detailTab === "editor" ? "secondary-button" : "ghost-button"} onClick={() => setDetailTab("editor")} style={{ fontSize: 12 }}>Editor</button>
                    <button type="button" className={detailTab === "history" ? "secondary-button" : "ghost-button"} onClick={() => setDetailTab("history")} style={{ fontSize: 12 }}>History</button>
                  </div>
                )}
                {trackerKind && <TrackerOwnedNotice kind={trackerKind} />}
                {selectedEntry && detailTab === "history" ? (
                  <LorebookHistory entry={selectedEntry} campaignId={campaignId} readOnly={readOnly} />
                ) : (
                <>
                <div className="lorebook-editor-columns">
                <div className="lorebook-editor-main">
                <div className="lorebook-editor-header">
                  <input
                    type="text"
                    placeholder="Entry name"
                    value={editName}
                    maxLength={TEXT_MAX.name}
                    onChange={e => { setEditName(e.target.value); setDirty(true); }}
                    className="lorebook-name-input"
                    readOnly={fieldsLocked}
                  />
                  <div className="lorebook-editor-toggles">
                    <label className="lorebook-toggle">
                      <input type="checkbox" checked={editIsEnabled} onChange={e => { setEditIsEnabled(e.target.checked); setDirty(true); }} disabled={fieldsLocked} />
                      <span>Enabled</span>
                    </label>
                    <label className="lorebook-toggle">
                      <input type="checkbox" checked={editIsConstant} onChange={e => { setEditIsConstant(e.target.checked); setDirty(true); }} disabled={fieldsLocked} />
                      <span>Constant</span>
                    </label>
                  </div>
                </div>

                <div className="lorebook-content-area">
                  <div className="lorebook-content-head">
                    <span className="lorebook-field-label">Content</span>
                    <div className="lorebook-face-switch" role="group" aria-label="Content typeface">
                      <button type="button" className={contentFace === "prose" ? "is-active" : ""} onClick={() => chooseContentFace("prose")} title="Reading face: sans, larger, capped line length">Prose</button>
                      <button type="button" className={contentFace === "mono" ? "is-active" : ""} onClick={() => chooseContentFace("mono")} title="Fixed-width face">Mono</button>
                    </div>
                  </div>
                  {(() => {
                    const spoilered = Boolean(selectedMarker?.provisional) && !spoilerRevealed && !creating;
                    return (
                      <div className={spoilered ? "lorebook-spoiler-wrap" : undefined} onClick={spoilered ? () => setSpoilerRevealed(true) : undefined}>
                        {spoilered && <div className="lorebook-spoiler-note"><Icon name="moon" size={12} /> Hidden world state (provisional) — click to reveal</div>}
                        <AutoTextarea
                          value={editContent}
                          maxLength={TEXT_MAX.content}
                          // Sized to the entry (2026-09-24): at least twelve lines, grows to
                          // show the whole content, scrolls inside only past ~200 lines; the editor panel
                          // scrolls and the action bar stays pinned to its bottom.
                          minRows={12}
                          maxRows={200}
                          onChange={e => { setEditContent(e.target.value); setDirty(true); }}
                          placeholder="Entry content..."
                          className={`lorebook-content-textarea face-${contentFace}${spoilered ? " spoiler-blur" : ""}`}
                          readOnly={spoilered || fieldsLocked}
                        />
                      </div>
                    );
                  })()}
                  <span className="muted" style={{ fontSize: 10, textAlign: "right" }}>
                    {/* The lorebook's one token estimate, the same number the list shows once saved. */}
                    ~{estimateLorebookTokens(editContent)} tokens
                  </span>
                  {selectedEntry && selectedMarker?.provisional && !creating && (
                    <button
                      type="button"
                      className="ghost-button small"
                      style={{ alignSelf: "flex-start" }}
                      title="Mark this offscreen event as confirmed on-page canon (keeps it out of the provisional filter; consolidation may then touch it)"
                      onClick={() => { if (campaignId) confirmMutation.mutate({ campaignId, entryId: selectedEntry.id }); }}
                      disabled={busy}
                    >
                      <Icon name="check" size={13} /> Confirm as canon
                    </button>
                  )}
                </div>

                </div>
                <div className="lorebook-editor-side">
                <div className="lorebook-field-row">
                  <label>
                    <span className="lorebook-field-label">Tag</span>
                    <input
                      type="text"
                      value={editTag}
                      maxLength={TEXT_MAX.tag}
                      onChange={e => { setEditTag(e.target.value); setDirty(true); }}
                      readOnly={fieldsLocked}
                      placeholder="characters, locations, events..."
                      list="lorebook-tag-suggestions"
                      style={{ fontSize: 12 }}
                    />
                    <datalist id="lorebook-tag-suggestions">
                      {visibleTags(tags.data?.tags).map(t => <option key={t} value={t} />)}
                    </datalist>
                  </label>
                  <label>
                    <span className="lorebook-field-label">Keys <span className="muted">(comma-separated)</span></span>
                    <AutoTextarea
                      value={editKeys}
                      maxRows={5}
                      singleLineEnter
                      onChange={e => { setEditKeys(e.target.value); setDirty(true); }}
                      readOnly={fieldsLocked}
                      placeholder="keyword1, keyword2..."
                      style={{ fontSize: 12 }}
                    />
                    {listNoteFor("keys")}
                  </label>
                </div>

                <div className="lorebook-field-row">
                  <label>
                    <span className="lorebook-field-label">Comment</span>
                    <AutoTextarea
                      value={editComment}
                      maxLength={TEXT_MAX.comment}
                      maxRows={6}
                      onChange={e => { setEditComment(e.target.value); setDirty(true); }}
                      readOnly={fieldsLocked}
                      placeholder="Internal note..."
                      style={{ fontSize: 12 }}
                    />
                  </label>
                  <label>
                    <span className="lorebook-field-label">Secondary keys</span>
                    <AutoTextarea
                      value={editKeysSecondary}
                      maxRows={5}
                      singleLineEnter
                      onChange={e => { setEditKeysSecondary(e.target.value); setDirty(true); }}
                      readOnly={fieldsLocked}
                      placeholder="secondary1, secondary2..."
                      style={{ fontSize: 12 }}
                    />
                    {listNoteFor("keysSecondary")}
                  </label>
                </div>

                <div className="lorebook-field-row">
                  <label style={{ flex: 1 }}>
                    <span className="lorebook-field-label">Known by <span className="muted">(comma-separated, blank = global)</span></span>
                    <AutoTextarea
                      value={editKnownBy}
                      maxRows={4}
                      singleLineEnter
                      onChange={e => { setEditKnownBy(e.target.value); setDirty(true); }}
                      readOnly={fieldsLocked}
                      placeholder="All characters (global knowledge)"
                      style={{ fontSize: 12 }}
                    />
                    {listNoteFor("knownBy")}
                  </label>
                </div>

                {/* Advanced settings */}
                <button type="button" className="ghost-button lorebook-advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
                  <Icon name={showAdvanced ? "chevron-down" : "chevron-right"} size={12} /> Advanced settings
                </button>
                {showAdvanced && <LorebookAdvancedFields values={advancedValues} bounds={DIAL_BOUNDS} onChange={changeAdvanced} readOnly={fieldsLocked} />}

                </div>
                </div>

                {/* Action buttons */}
                <div className="lorebook-editor-actions">
                  {readOnly ? (
                    <span className="muted" style={{ fontSize: 11 }}>Read-only: kept by the thread tracker.</span>
                  ) : (
                  <>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={saveEntry}
                    disabled={busy || !editName.trim() || !editContent.trim()}
                  >
                    {creating ? "Create" : "Save"}
                  </button>
                  {!creating && selectedEntryId && (
                    confirmDeleteEntry ? (
                      <>
                        <button
                          type="button"
                          className="danger-button"
                          onClick={() => { if (campaignId) deleteMutation.mutate({ campaignId, entryId: selectedEntryId }); setConfirmDeleteEntry(false); }}
                          disabled={busy}
                        >
                          Confirm delete
                        </button>
                        <button type="button" className="ghost-button" onClick={() => setConfirmDeleteEntry(false)}>Cancel</button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() => setConfirmDeleteEntry(true)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    )
                  )}
                  </>
                  )}
                  {dirty && <span className="muted" style={{ fontSize: 11 }}>unsaved changes</span>}
                  {serverChanged && selectedEntry && (
                    <span className="muted" style={{ fontSize: 11 }}>
                      · this entry changed on the server while you were editing —{" "}
                      <button type="button" className="ghost-button" style={{ fontSize: 11, padding: "0 4px" }} onClick={() => seedEditorFields(selectedEntry)}>reload it (discards your edits)</button>
                    </span>
                  )}
                </div>
                </>
                )}
              </>
            ) : selectedSummary ? (
              <div className="lorebook-editor-empty">
                <QueryError query={selectedEntryQuery} label="Unable to load this entry" />
                {selectedEntryQuery.isError ? null : <p className="muted">Loading {selectedSummary.name}…</p>}
              </div>
            ) : (
              <div className="lorebook-editor-empty">
                <p className="muted">Select an entry or create a new one</p>
                {campaignId && (
                  <div className="lorebook-embedding-card">
                    <p className="lorebook-field-label" style={{ marginBottom: 4 }}>Embeddings</p>
                    <QueryError query={embeddingStatus} label="Unable to load embedding status" />
                    {embeddingStatus.data ? (
                      <>
                        <p className="muted" style={{ fontSize: 11 }}>
                          {embeddingStatus.data.indexed}/{embeddingStatus.data.totalEntries} indexed
                          {embeddingStatus.data.stale > 0 && ` · ${embeddingStatus.data.stale} stale`}
                          {embeddingStatus.data.missing > 0 && ` · ${embeddingStatus.data.missing} missing`}
                        </p>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => setRebuildOpen(true)}
                          disabled={rebuildMutation.isPending}
                          style={{ fontSize: 11, marginTop: 4 }}
                        >
                          {rebuildMutation.isPending ? "Rebuilding..." : "Rebuild Embeddings…"}
                        </button>
                      </>
                    ) : embeddingStatus.isLoading ? (
                      <p className="muted" style={{ fontSize: 11 }}>Loading...</p>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        )}

        {/* Import dialog overlay */}
        {panelView === "lorebook" && showImport && (
          <div className="lorebook-import-overlay">
            <div className="lorebook-import-card">
              <p className="eyebrow">Import Lorebook</p>
              <p className="muted small-copy">Import a SillyTavern World Info JSON file.</p>
              <input
                type="file"
                accept=".json"
                onChange={handleImportFile}
                style={{ fontSize: 12, marginTop: 8 }}
              />
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <button type="button" className="secondary-button" onClick={() => setShowImport(false)}>Cancel</button>
              </div>
              {importMutation.isPending && <p className="muted small-copy" style={{ marginTop: 8 }}>Importing...</p>}
            </div>
          </div>
        )}

        {rebuildOpen && campaignId && (
          <RebuildEmbeddingsDialog
            campaignName={campaignName}
            modelLabel={(() => {
              const id = campaignEmbeddingModel ?? embeddingStatus.data?.model ?? "";
              return EMBEDDING_MODELS.find((m) => m.id === id)?.label ?? (id || "the default embedding model");
            })()}
            status={embeddingStatus.data}
            pending={rebuildMutation.isPending}
            onClose={() => setRebuildOpen(false)}
            onRebuild={(staleOnly) => rebuildMutation.mutate({ campaignId, campaignName, model: campaignEmbeddingModel, staleOnly })}
          />
        )}

        {pendingNav && (
          <Dialog
            open
            onClose={() => setPendingNav(null)}
            label="Discard unsaved changes"
            eyebrow="Unsaved Changes"
            title={editName.trim() || "This entry"}
            icon="alert"
            size="sm"
            zIndex={300}
            footer={<>
                <button type="button" className="secondary-button" onClick={() => setPendingNav(null)}>Keep Editing</button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => {
                    const action = pendingNav.run;
                    setPendingNav(null);
                    // "Discard" must actually discard: clearing only `dirty` left the
                    // edited text in the fields (and Save wrote it) whenever the entry
                    // stayed selected through the action.
                    if (selectedEntry && !creating) seedEditorFields(selectedEntry);
                    else resetEditor();
                    action();
                  }}
                >
                  Discard Changes
                </button>
            </>}
          >
            <p className="muted">You have unsaved edits in this entry. Continuing will discard them.</p>
          </Dialog>
        )}
    </Dialog>
  );
}
