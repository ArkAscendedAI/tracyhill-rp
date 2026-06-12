import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { LorebookEntry } from "@tracyhill-rp/contracts";

import { NumericInput } from "../../shared/ui/NumericInput";

import { useCampaigns } from "../campaigns/useCampaigns";
import {
  getLorebookEntries,
  getLorebookTags,
  createLorebookEntry,
  updateLorebookEntry,
  deleteLorebookEntry,
  bulkLorebookAction,
  importLorebook,
  getEmbeddingStatus,
  rebuildEmbeddings,
} from "./lorebookApi";

type LorebookPanelProps = {
  open: boolean;
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


// Split a comma-separated key list WITHOUT breaking regex keys: a token that
// starts with "/" runs until its CLOSING unescaped "/" (+flags), so commas
// inside quantifiers like {1,2} or alternations are not separators. The old
// naive split corrupted every regex key on any unrelated save.
function splitKeyList(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let inRegex = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (!inRegex && ch === "/" && current.trim() === "") {
      inRegex = true;
      current += ch;
      continue;
    }
    if (inRegex && ch === "/" && raw[i - 1] !== "\\") {
      inRegex = false;
      current += ch;
      continue;
    }
    if (ch === "," && !inRegex) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

export function LorebookPanel({ open, onClose }: LorebookPanelProps) {
  const queryClient = useQueryClient();
  const campaigns = useCampaigns();
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [sortField, setSortField] = useState<string>("updated_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
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
  const [info, setInfo] = useState<string | null>(null);
  // Two-step delete confirmations (project rule: in-app confirmation for
  // destructive actions — these were single-click).
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [dirty, setDirty] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Status/rebuild must target the CAMPAIGN's embedding model — defaulting to
  // openai reported the wrong vector namespace and a rebuild spent paid API
  // embedding into a model the campaign doesn't retrieve with.
  const campaignEmbeddingModel = ((): string | undefined => {
    const campaign = campaigns.data?.campaigns.find((c) => c.id === campaignId);
    const model = (campaign?.contextDefaults as { embeddingModel?: string } | null | undefined)?.embeddingModel;
    return typeof model === "string" && model ? model : undefined;
  })();

  const entries = useQuery({
    queryKey: ["lorebook-entries", campaignId, tagFilter, searchQuery, sortField, sortOrder],
    queryFn: () => campaignId ? getLorebookEntries(campaignId, { tag: tagFilter || undefined, search: searchQuery || undefined, sort: sortField, order: sortOrder }) : Promise.resolve({ entries: [], total: 0 }),
    // Gated on `open` too: this panel is mounted with the app shell, so every
    // page load used to fetch the full Buffy lorebook for a closed dialog.
    enabled: Boolean(campaignId) && open,
    // Keep the previous page while a new search/filter key loads — the list
    // used to flash empty and unmount the open editor mid-keystroke.
    placeholderData: (prev) => prev,
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

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["lorebook-entries", campaignId] });
    queryClient.invalidateQueries({ queryKey: ["lorebook-tags", campaignId] });
  };

  const createMutation = useMutation({
    mutationFn: (payload: Parameters<typeof createLorebookEntry>[1]) => createLorebookEntry(campaignId!, payload),
    onSuccess: () => { invalidate(); setCreating(false); resetEditor(); },
    onError: (e) => setError(e instanceof Error ? e.message : "create failed"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ entryId, payload }: { entryId: string; payload: Parameters<typeof updateLorebookEntry>[1] }) => updateLorebookEntry(entryId, payload),
    onSuccess: () => { invalidate(); setDirty(false); },
    onError: (e) => setError(e instanceof Error ? e.message : "update failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteLorebookEntry,
    onSuccess: () => { invalidate(); setSelectedEntryId(null); resetEditor(); },
    onError: (e) => setError(e instanceof Error ? e.message : "delete failed"),
  });

  const bulkMutation = useMutation({
    mutationFn: (payload: Parameters<typeof bulkLorebookAction>[1]) => bulkLorebookAction(campaignId!, payload),
    onSuccess: () => { invalidate(); setSelectedIds(new Set()); setBulkMode(false); },
    onError: (e) => setError(e instanceof Error ? e.message : "bulk action failed"),
  });

  const importMutation = useMutation({
    mutationFn: (data: unknown) => importLorebook(campaignId!, data),
    onSuccess: (result) => {
      invalidate();
      setShowImport(false);
      setInfo(`Imported ${result.imported} entries${result.skipped ? `, skipped ${result.skipped}` : ""}${result.errors.length ? `, ${result.errors.length} errors` : ""}`);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "import failed"),
  });

  const rebuildMutation = useMutation({
    mutationFn: () => rebuildEmbeddings(campaignId!, campaignEmbeddingModel),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["embedding-status", campaignId] }),
    onError: (e) => setError(e instanceof Error ? e.message : "rebuild failed"),
  });

  useEffect(() => { setConfirmDeleteEntry(false); }, [selectedEntryId]);
  useEffect(() => { setConfirmBulkDelete(false); }, [selectedIds]);

  const selectedEntry = useMemo(() => entries.data?.entries.find(e => e.id === selectedEntryId) ?? null, [entries.data, selectedEntryId]);

  // Auto-select first campaign that has lorebook entries
  useEffect(() => {
    if (!campaignId && campaigns.data?.campaigns.length) {
      const withEntries = campaigns.data.campaigns.find(c => (c.lorebookEntryCount ?? 0) > 0) ?? campaigns.data.campaigns[0];
      if (withEntries) setCampaignId(withEntries.id);
    }
  }, [campaignId, campaigns.data]);

  const selectEntry = (entry: LorebookEntry) => {
    setSelectedEntryId(entry.id);
    setCreating(false);
    setEditName(entry.name);
    setEditContent(entry.content);
    setEditTag(entry.tag ?? "");
    setEditKeys(entry.keys.join(", "));
    setEditKeysSecondary(entry.keysSecondary.join(", "));
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
    setEditKnownBy(entry.knownBy ? entry.knownBy.join(", ") : "");
    setShowAdvanced(false);
    setDirty(false);
    setError("");
  };

  const resetEditor = () => {
    setEditName(""); setEditContent(""); setEditTag(""); setEditKeys(""); setEditKeysSecondary("");
    setEditComment(""); setEditPosition("before_main"); setEditInsertionOrder(100); setEditScanDepth(4);
    setEditSelectiveLogic("and_any"); setEditProbability(100); setEditIsConstant(false); setEditIsEnabled(true);
    setEditSticky(0); setEditCooldown(0); setEditDelay(0); setEditExcludeRecursion(false);
    setEditPreventRecursion(false); setEditDelayUntilRecursion(false); setEditKnownBy(""); setShowAdvanced(false); setDirty(false);
  };

  const startCreate = () => {
    setSelectedEntryId(null);
    setCreating(true);
    resetEditor();
    setError("");
  };

  const buildPayload = () => ({
    name: editName.trim(),
    content: editContent.trim(),
    tag: editTag.trim() || null,
    comment: editComment.trim() || null,
    keys: splitKeyList(editKeys),
    keysSecondary: splitKeyList(editKeysSecondary),
    position: editPosition as "before_main" | "after_main" | "top" | "bottom",
    insertionOrder: editInsertionOrder,
    scanDepth: editScanDepth,
    selectiveLogic: editSelectiveLogic as "and_any" | "and_all" | "not_all" | "not_any",
    probability: editProbability,
    isConstant: editIsConstant,
    isEnabled: editIsEnabled,
    sticky: editSticky,
    cooldown: editCooldown,
    delay: editDelay,
    excludeRecursion: editExcludeRecursion,
    preventRecursion: editPreventRecursion,
    delayUntilRecursion: editDelayUntilRecursion,
    knownBy: editKnownBy.trim() ? editKnownBy.split(",").map(k => k.trim()).filter(Boolean) : null,
  });

  const saveEntry = () => {
    const payload = buildPayload();
    if (!payload.name || !payload.content) return;
    if (creating) {
      createMutation.mutate(payload);
    } else if (selectedEntryId) {
      updateMutation.mutate({ entryId: selectedEntryId, payload });
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        importMutation.mutate(data);
      } catch {
        setError("invalid JSON file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const toggleBulkSelect = (entryId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const busy = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending || bulkMutation.isPending || importMutation.isPending;

  const entryList = entries.data?.entries ?? [];
  const totalTokens = entryList.reduce((sum, e) => sum + e.tokensEstimate, 0);
  const enabledCount = entryList.filter(e => e.isEnabled).length;
  const constantCount = entryList.filter(e => e.isConstant).length;

  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog-card lorebook-dialog" role="dialog" aria-modal="true" aria-label="Lorebook">
        {/* Topbar */}
        <div className="cc-topbar">
          <span style={{ fontSize: 14 }}>&#x1F4D6;</span>
          <span className="cc-title">Lorebook</span>
          <select
            value={campaignId ?? ""}
            onChange={e => { setCampaignId(e.target.value || null); setSelectedEntryId(null); resetEditor(); setCreating(false); }}
            style={{ flex: 1, minWidth: 0, fontSize: 12 }}
          >
            <option value="">Select campaign...</option>
            {campaigns.data?.campaigns.map(c => <option key={c.id} value={c.id}>{c.name} ({c.lorebookEntryCount ?? 0})</option>)}
          </select>
          <span className="muted" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
            {entryList.length} entries &middot; ~{(totalTokens / 1000).toFixed(1)}k tok
          </span>
          <button type="button" className="ghost-button" onClick={onClose} title="Close">&#x2715;</button>
        </div>

        {error && <div className="lorebook-error" onClick={() => setError("")}>{error}</div>}
        {info && <div className="lorebook-info" onClick={() => setInfo(null)}>{info}</div>}

        <div className="lorebook-body">
          {/* Left: Entry List */}
          <div className="lorebook-list-panel">
            <div className="lorebook-list-toolbar">
              <input
                type="text"
                placeholder="Search entries..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="lorebook-search"
              />
              <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} className="lorebook-tag-filter">
                <option value="">All tags</option>
                {(tags.data?.tags ?? []).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="lorebook-list-actions">
              <button type="button" className="ghost-button" onClick={startCreate} disabled={!campaignId}>+ New</button>
              <button type="button" className="ghost-button" onClick={() => setBulkMode(!bulkMode)}>
                {bulkMode ? "Cancel" : "Select"}
              </button>
              <button type="button" className="ghost-button" onClick={() => setShowImport(true)} disabled={!campaignId}>Import</button>
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
                <span className="muted" style={{ fontSize: 11 }}>{selectedIds.size} selected</span>
                <button type="button" className="ghost-button" onClick={() => bulkMutation.mutate({ entryIds: [...selectedIds], action: "enable" })} disabled={busy}>Enable</button>
                <button type="button" className="ghost-button" onClick={() => bulkMutation.mutate({ entryIds: [...selectedIds], action: "disable" })} disabled={busy}>Disable</button>
                {confirmBulkDelete ? (
                  <>
                    <button type="button" className="ghost-button danger-text" onClick={() => { bulkMutation.mutate({ entryIds: [...selectedIds], action: "delete" }); setConfirmBulkDelete(false); }} disabled={busy}>Confirm delete {selectedIds.size}</button>
                    <button type="button" className="ghost-button" onClick={() => setConfirmBulkDelete(false)}>Cancel</button>
                  </>
                ) : (
                  <button type="button" className="ghost-button danger-text" onClick={() => setConfirmBulkDelete(true)} disabled={busy}>Delete</button>
                )}
              </div>
            )}

            <div className="lorebook-entries-list">
              {entries.isLoading && <p className="muted small-copy" style={{ padding: 8 }}>Loading...</p>}
              {entryList.map(entry => (
                <div
                  key={entry.id}
                  className={`lorebook-entry-item${entry.id === selectedEntryId ? " active" : ""}${!entry.isEnabled ? " disabled-entry" : ""}`}
                  onClick={() => bulkMode ? toggleBulkSelect(entry.id) : selectEntry(entry)}
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
                      {entry.isConstant && <span className="lorebook-const-badge">const</span>}
                      {entry.compressedRefIds && entry.compressedRefIds.length > 0 && <span className="lorebook-archived-badge" title={`Compressed trigger for ${entry.compressedRefIds.length} cold entries`}>archived</span>}
                      {!entry.isEnabled && <span className="lorebook-off-badge">off</span>}
                    </span>
                  </div>
                </div>
              ))}
              {!entries.isLoading && entryList.length === 0 && campaignId && (
                <p className="muted small-copy" style={{ padding: 12 }}>No entries. Click "+ New" or "Import" to add lorebook entries.</p>
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
            {(selectedEntry || creating) ? (
              <>
                <div className="lorebook-editor-header">
                  <input
                    type="text"
                    placeholder="Entry name"
                    value={editName}
                    onChange={e => { setEditName(e.target.value); setDirty(true); }}
                    className="lorebook-name-input"
                  />
                  <div className="lorebook-editor-toggles">
                    <label className="lorebook-toggle">
                      <input type="checkbox" checked={editIsEnabled} onChange={e => { setEditIsEnabled(e.target.checked); setDirty(true); }} />
                      <span>Enabled</span>
                    </label>
                    <label className="lorebook-toggle">
                      <input type="checkbox" checked={editIsConstant} onChange={e => { setEditIsConstant(e.target.checked); setDirty(true); }} />
                      <span>Constant</span>
                    </label>
                  </div>
                </div>

                <div className="lorebook-field-row">
                  <label>
                    <span className="lorebook-field-label">Tag</span>
                    <input
                      type="text"
                      value={editTag}
                      onChange={e => { setEditTag(e.target.value); setDirty(true); }}
                      placeholder="characters, locations, events..."
                      list="lorebook-tag-suggestions"
                      style={{ fontSize: 12 }}
                    />
                    <datalist id="lorebook-tag-suggestions">
                      {(tags.data?.tags ?? []).map(t => <option key={t} value={t} />)}
                    </datalist>
                  </label>
                  <label>
                    <span className="lorebook-field-label">Keys <span className="muted">(comma-separated)</span></span>
                    <input
                      type="text"
                      value={editKeys}
                      onChange={e => { setEditKeys(e.target.value); setDirty(true); }}
                      placeholder="keyword1, keyword2..."
                      style={{ fontSize: 12 }}
                    />
                  </label>
                </div>

                <div className="lorebook-content-area">
                  <span className="lorebook-field-label">Content</span>
                  <textarea
                    value={editContent}
                    onChange={e => { setEditContent(e.target.value); setDirty(true); }}
                    placeholder="Entry content..."
                    className="lorebook-content-textarea"
                  />
                  <span className="muted" style={{ fontSize: 10, textAlign: "right" }}>
                    ~{Math.ceil(editContent.length / 3.5)} tokens
                  </span>
                </div>

                <div className="lorebook-field-row">
                  <label>
                    <span className="lorebook-field-label">Comment</span>
                    <input
                      type="text"
                      value={editComment}
                      onChange={e => { setEditComment(e.target.value); setDirty(true); }}
                      placeholder="Internal note..."
                      style={{ fontSize: 12 }}
                    />
                  </label>
                  <label>
                    <span className="lorebook-field-label">Secondary keys</span>
                    <input
                      type="text"
                      value={editKeysSecondary}
                      onChange={e => { setEditKeysSecondary(e.target.value); setDirty(true); }}
                      placeholder="secondary1, secondary2..."
                      style={{ fontSize: 12 }}
                    />
                  </label>
                </div>

                <div className="lorebook-field-row">
                  <label style={{ flex: 1 }}>
                    <span className="lorebook-field-label">Known by <span className="muted">(comma-separated, blank = global)</span></span>
                    <input
                      type="text"
                      value={editKnownBy}
                      onChange={e => { setEditKnownBy(e.target.value); setDirty(true); }}
                      placeholder="All characters (global knowledge)"
                      style={{ fontSize: 12 }}
                    />
                  </label>
                </div>

                {/* Advanced settings */}
                <button type="button" className="ghost-button lorebook-advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
                  {showAdvanced ? "▾" : "▸"} Advanced settings
                </button>
                {showAdvanced && (
                  <div className="lorebook-advanced">
                    <div className="lorebook-advanced-grid">
                      <label>
                        <span className="lorebook-field-label">Position</span>
                        <select value={editPosition} onChange={e => { setEditPosition(e.target.value); setDirty(true); }}>
                          <option value="before_main">Before Main</option>
                          <option value="after_main">After Main</option>
                          <option value="top">Top</option>
                          <option value="bottom">Bottom</option>
                        </select>
                      </label>
                      <label>
                        <span className="lorebook-field-label">Insertion order</span>
                        <NumericInput value={editInsertionOrder} onChange={v => { setEditInsertionOrder(v); setDirty(true); }} min={0} max={10000} />
                      </label>
                      <label>
                        <span className="lorebook-field-label">Scan depth</span>
                        <NumericInput value={editScanDepth} onChange={v => { setEditScanDepth(v); setDirty(true); }} min={0} max={100} />
                      </label>
                      <label>
                        <span className="lorebook-field-label">Selective logic</span>
                        <select value={editSelectiveLogic} onChange={e => { setEditSelectiveLogic(e.target.value); setDirty(true); }}>
                          <option value="and_any">AND ANY</option>
                          <option value="and_all">AND ALL</option>
                          <option value="not_all">NOT ALL</option>
                          <option value="not_any">NOT ANY</option>
                        </select>
                      </label>
                      <label>
                        <span className="lorebook-field-label">Probability %</span>
                        <NumericInput value={editProbability} onChange={v => { setEditProbability(v); setDirty(true); }} min={0} max={100} />
                      </label>
                      <label>
                        <span className="lorebook-field-label">Sticky turns</span>
                        <NumericInput value={editSticky} onChange={v => { setEditSticky(v); setDirty(true); }} min={0} />
                      </label>
                      <label>
                        <span className="lorebook-field-label">Cooldown turns</span>
                        <NumericInput value={editCooldown} onChange={v => { setEditCooldown(v); setDirty(true); }} min={0} />
                      </label>
                      <label>
                        <span className="lorebook-field-label">Delay turns</span>
                        <NumericInput value={editDelay} onChange={v => { setEditDelay(v); setDirty(true); }} min={0} />
                      </label>
                    </div>
                    <div className="lorebook-advanced-checks">
                      <label className="lorebook-toggle">
                        <input type="checkbox" checked={editExcludeRecursion} onChange={e => { setEditExcludeRecursion(e.target.checked); setDirty(true); }} />
                        <span>Exclude from recursion</span>
                      </label>
                      <label className="lorebook-toggle">
                        <input type="checkbox" checked={editPreventRecursion} onChange={e => { setEditPreventRecursion(e.target.checked); setDirty(true); }} />
                        <span>Prevent recursion</span>
                      </label>
                      <label className="lorebook-toggle">
                        <input type="checkbox" checked={editDelayUntilRecursion} onChange={e => { setEditDelayUntilRecursion(e.target.checked); setDirty(true); }} />
                        <span>Delay until recursion</span>
                      </label>
                    </div>
                  </div>
                )}

                {/* Action buttons */}
                <div className="lorebook-editor-actions">
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
                          onClick={() => { deleteMutation.mutate(selectedEntryId); setConfirmDeleteEntry(false); }}
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
                  {dirty && <span className="muted" style={{ fontSize: 11 }}>unsaved changes</span>}
                </div>
              </>
            ) : (
              <div className="lorebook-editor-empty">
                <p className="muted">Select an entry or create a new one</p>
                {campaignId && (
                  <div className="lorebook-embedding-card">
                    <p className="lorebook-field-label" style={{ marginBottom: 4 }}>Embeddings</p>
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
                          onClick={() => rebuildMutation.mutate()}
                          disabled={rebuildMutation.isPending}
                          style={{ fontSize: 11, marginTop: 4 }}
                        >
                          {rebuildMutation.isPending ? "Rebuilding..." : "Rebuild Embeddings"}
                        </button>
                      </>
                    ) : (
                      <p className="muted" style={{ fontSize: 11 }}>Loading...</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Import dialog overlay */}
        {showImport && (
          <div className="lorebook-import-overlay">
            <div className="lorebook-import-card">
              <p className="eyebrow">Import Lorebook</p>
              <p className="muted small-copy">Import a SillyTavern World Info JSON file.</p>
              <input
                ref={fileInputRef}
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
      </section>
    </div>
  );
}
