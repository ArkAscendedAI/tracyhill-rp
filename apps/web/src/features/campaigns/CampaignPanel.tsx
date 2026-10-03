import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createUserScopedCacheWriter } from "../auth/authCache";

import { contextSettingsSchema, enqueueWizardRunRequestSchema, updateWizardTemplatesRequestSchema, type CampaignsListResponse } from "@tracyhill-rp/contracts";

import { DiffView } from "../../shared/ui/DiffView";
import { resolveWizardTemplateSeed } from "./wizardTemplateDraft";
import { planCampaignSave } from "./campaignSave";
import { NumericInput } from "../../shared/ui/NumericInput";
import { QueryError } from "../../shared/ui/QueryError";
import { overLimitMessage } from "../../shared/text/lengthCap";
import { stringMaxLength } from "../lorebook/contractBounds";

import { buildAvailableChatModels, getProviderKeys } from "../auth/providerKeyApi";
import { createCampaign, deleteCampaign, getCampaignVersions, restoreCampaignVersion, updateCampaign } from "./campaignApi";
import { cancelPipelineRun, getPipelineRuns } from "../pipeline/pipelineApi";
import { CampaignAuditDialog } from "../pipeline/CampaignAuditDialog";
import { CancelRunDialog } from "../pipeline/CancelRun";
import { formatPipelineStatus, type CancelRunTarget } from "../pipeline/pipelineUtils";
import { approveWizardRun, cancelWizardRun, dismissWizardRun, enqueueWizardRun, getWizardRuns, getWizardTemplates, retryWizardRun, updateWizardTemplates } from "../wizard/wizardApi";
import { WizardReviewDialog } from "../wizard/WizardReviewDialog";
import { CancelWizardDialog } from "../wizard/CancelWizardDialog";
import { cancelWizardTargetOf, formatWizardStatus, type CancelWizardTarget } from "../wizard/wizardUtils";
import { startSessionFromCampaign } from "../workspace/workspaceApi";
import { flattenFolderOptions } from "../workspace/folderTree";
import { useWorkspaceState } from "../workspace/useWorkspaceState";
import { useCampaigns } from "./useCampaigns";
import { Icon } from "../../shared/ui/Icon";
import { Dialog } from "../../shared/ui/Dialog";
import { AutoTextarea } from "../../shared/ui/AutoTextarea";
import "../../styles/feature-campaign.css";

// The campaign editor has no session, so its audit dialog defaults to the
// contract's auditModel default rather than a literal model id.
const CONTRACT_AUDIT_MODEL_DEFAULT = contextSettingsSchema.shape.auditModel.parse(undefined);
// The wizard template contract's limit: a longer example prompt came back as a bare "invalid wizard template
// request". It is named under the field and Save Templates waits.
const WIZARD_TEMPLATE_MAX = stringMaxLength(updateWizardTemplatesRequestSchema.shape.exampleSystemPrompt) ?? Infinity;
// The same for a wizard run (the enqueue contract, "invalid wizard run request"): the campaign name stops at its
// limit; an over-long brief or transcript is named under the form and Run Wizard waits.
const ENQUEUE_FIELDS = enqueueWizardRunRequestSchema.innerType().shape;
const WIZARD_RUN_MAX = {
  campaignName: stringMaxLength(ENQUEUE_FIELDS.campaignName),
  brief: stringMaxLength(ENQUEUE_FIELDS.brief) ?? Infinity,
  transcript: stringMaxLength(ENQUEUE_FIELDS.wizardTranscript) ?? Infinity,
};

type CampaignPanelProps = {
  open: boolean;
  onClose: () => void;
};

export function CampaignPanel({ open, onClose }: CampaignPanelProps) {
  const queryClient = useQueryClient();
  const cacheUserQuery = createUserScopedCacheWriter(queryClient);
  const campaigns = useCampaigns();
  const workspace = useWorkspaceState();
  const providerConfig = useQuery({
    queryKey: ["provider-keys"],
    queryFn: getProviderKeys,
    enabled: open,
  });
  const availableFolders = workspace.data?.folders ?? [];
  const availableFolderOptions = flattenFolderOptions(availableFolders);
  const availableChatModels = buildAvailableChatModels(providerConfig.data);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  // Deleting a campaign also deletes its lorebook — confirm in-app.
  const [confirmDeleteCampaign, setConfirmDeleteCampaign] = useState(false);
  const [auditDialogOpen, setAuditDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [topTab, setTopTab] = useState<"campaigns" | "wizard">("campaigns");
  const [editorTab, setEditorTab] = useState<"system" | "pipeline" | "history">("system");
  const [newName, setNewName] = useState("");
  const [newFolderId, setNewFolderId] = useState("root");
  const [newVersion, setNewVersion] = useState(0);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingFolderId, setEditingFolderId] = useState("root");
  const [editingVersion, setEditingVersion] = useState(0);
  const [editingInitialVersion, setEditingInitialVersion] = useState(0);
  const [editingSystemPrompt, setEditingSystemPrompt] = useState("");
  const [wizardExampleSystemPrompt, setWizardExampleSystemPrompt] = useState("");
  // The server text the textarea was last seeded from, and whether a refetch
  // saw a different server value under an unsaved edit.
  const [wizardTemplateSeed, setWizardTemplateSeed] = useState<string | null>(null);
  const [wizardTemplateServerChanged, setWizardTemplateServerChanged] = useState(false);
  const [wizardCampaignName, setWizardCampaignName] = useState("");
  // null = the user hasn't picked yet; the effective value falls through to the
  // deployment DEFAULT_MODEL_ID override (from the provider-keys bootstrap, which
  // may arrive after mount) and then the first available model. Empty when no
  // model is keyed — Run Wizard is disabled rather than pinning a literal id
  // the server would reject.
  const [wizardModelIdRaw, setWizardModelId] = useState<string | null>(null);
  const wizardModelId = wizardModelIdRaw ?? providerConfig.data?.defaultModelOverride ?? availableChatModels[0]?.id ?? "";
  const [wizardBrief, setWizardBrief] = useState("");
  const [wizardTranscript, setWizardTranscript] = useState("");
  const [reviewingWizardRunId, setReviewingWizardRunId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // In-app confirm before discarding unsaved editor changes when switching
  // campaign rows. Holds the campaign the user clicked while the current one is dirty.
  const [pendingSwitchCampaign, setPendingSwitchCampaign] = useState<CampaignsListResponse["campaigns"][number] | null>(null);
  // A History restore requested while the editor holds unsaved edits, awaiting the in-app confirm.
  const [pendingRestore, setPendingRestore] = useState<{ campaignId: string; version: number; archiveId: string | null } | null>(null);

  const wizardTemplates = useQuery({
    queryKey: ["wizard-templates"],
    queryFn: getWizardTemplates,
    // The panel is mounted with the app shell — without the gate these queries
    // ran (and the wizard poll fired) on every page load with the panel CLOSED.
    enabled: open,
  });
  const wizardRuns = useQuery({
    queryKey: ["wizard-runs"],
    queryFn: getWizardRuns,
    enabled: open,
    refetchInterval: (query) => {
      const status = query.state.data?.runs[0]?.status;
      // Wizard runs take minutes — 250ms was ~4 req/s per open tab.
      return status === "queued" || status === "running" ? 2_000 : false;
    },
  });

  useEffect(() => {
    if (!wizardTemplates.data) return;
    // Never clobber an unsaved edit: a focus refetch that observed another
    // client's save used to overwrite the textarea silently. Seed
    // only while the draft still equals what it was seeded from; otherwise
    // say the server copy changed and let the user reload it deliberately.
    const incoming = wizardTemplates.data.templates.exampleSystemPrompt;
    const decision = resolveWizardTemplateSeed({ seeded: wizardTemplateSeed, draft: wizardExampleSystemPrompt, incoming });
    if (decision.seed) {
      setWizardExampleSystemPrompt(incoming);
      setWizardTemplateSeed(incoming);
      setWizardTemplateServerChanged(false);
    } else {
      setWizardTemplateServerChanged(decision.serverChanged);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on server data only; the draft/seed are read, not tracked
  }, [wizardTemplates.data]);

  useEffect(() => {
    if (!availableChatModels.length) return;
    // Keep the wizard model picker normalized to a valid catalog id: an explicit
    // pick that leaves the list (e.g. a removed custom endpoint) reverts to the
    // default chain rather than pinning a stale id.
    if (wizardModelIdRaw && !availableChatModels.some((model) => model.id === wizardModelIdRaw)) setWizardModelId(null);
  }, [availableChatModels, wizardModelIdRaw]);

  const setCampaignState = (next: CampaignsListResponse) => {
    cacheUserQuery(["campaigns"], next);
  };

  const createCampaignMutation = useMutation({
    mutationFn: createCampaign,
    onSuccess: setCampaignState,
  });
  const updateCampaignMutation = useMutation({
    mutationFn: ({ campaignId, payload }: { campaignId: string; payload: Parameters<typeof updateCampaign>[1] }) => updateCampaign(campaignId, payload),
    onSuccess: setCampaignState,
  });
  const deleteCampaignMutation = useMutation({
    mutationFn: deleteCampaign,
    onSuccess: setCampaignState,
    onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "campaign delete failed"),
  });
  const restoreVersionMutation = useMutation({
    mutationFn: ({ campaignId, version, archiveId }: { campaignId: string; version: number; archiveId: string | null }) => restoreCampaignVersion(campaignId, version, archiveId),
    onSuccess: (next, variables) => {
      setCampaignState(next);
      void queryClient.invalidateQueries({ queryKey: ["campaign-versions", variables.campaignId] });
      // Re-seed the open editor — its fields kept the PRE-restore values, so a
      // subsequent Save silently clobbered the restore.
      const updated = next.campaigns.find((entry) => entry.id === variables.campaignId);
      if (updated && editingCampaignId === variables.campaignId) selectCampaign(updated);
    },
    onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "version restore failed"),
  });
  const startSessionMutation = useMutation({
    mutationFn: startSessionFromCampaign,
    onSuccess: (next) => {
      cacheUserQuery(["workspace-state"], next);
    },
    onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "start session failed"),
  });
  const cancelPipelineMutation = useMutation({
    mutationFn: ({ campaignId, runId }: { campaignId: string; runId: string }) => cancelPipelineRun(campaignId, runId),
    onSuccess: (next) => {
      cacheUserQuery(["pipeline-runs", next.campaignId], next);
      void queryClient.invalidateQueries({ queryKey: ["pipeline-active"] });
    },
    onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "pipeline cancel failed"),
  });
  const updateWizardTemplatesMutation = useMutation({
    mutationFn: updateWizardTemplates,
    onSuccess: (next) => {
      cacheUserQuery(["wizard-templates"], next);
    },
  });
  const enqueueWizardMutation = useMutation({
    mutationFn: enqueueWizardRun,
    onSuccess: (next) => {
      cacheUserQuery(["wizard-runs"], next);
    },
  });
  const approveWizardMutation = useMutation({
    mutationFn: ({ runId, payload }: { runId: string; payload: Parameters<typeof approveWizardRun>[1] }) => approveWizardRun(runId, payload),
    onSuccess: (next) => {
      cacheUserQuery(["wizard-runs"], next);
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
      void queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
    },
  });
  const retryWizardMutation = useMutation({
    mutationFn: retryWizardRun,
    onSuccess: (next) => {
      cacheUserQuery(["wizard-runs"], next);
      void queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
    },
  });
  const cancelWizardMutation = useMutation({
    mutationFn: cancelWizardRun,
    onSuccess: (next) => {
      cacheUserQuery(["wizard-runs"], next);
      void queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
    },
  });
  const dismissWizardMutation = useMutation({
    mutationFn: dismissWizardRun,
    onSuccess: (next) => {
      cacheUserQuery(["wizard-runs"], next);
      void queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
    },
  });

  const busy = createCampaignMutation.isPending
    || updateCampaignMutation.isPending
    || deleteCampaignMutation.isPending
    || restoreVersionMutation.isPending
    || startSessionMutation.isPending
    || cancelPipelineMutation.isPending
    || updateWizardTemplatesMutation.isPending
    || enqueueWizardMutation.isPending
    || approveWizardMutation.isPending
    || retryWizardMutation.isPending
    || cancelWizardMutation.isPending
    || dismissWizardMutation.isPending;
  const reviewingWizardRun = wizardRuns.data?.runs.find((run) => run.id === reviewingWizardRunId) ?? null;

  // Declared ABOVE the early return: `restoreVersionMutation.onSuccess` closes
  // over it, and react-query re-points a pending mutation at the latest
  // render's options — a render that returned early (panel closed mid-restore)
  // left `selectCampaign` in its TDZ and the callback threw.
  const selectCampaign = (campaign: CampaignsListResponse["campaigns"][number]) => {
    setSelectedCampaignId(campaign.id);
    setEditingCampaignId(campaign.id);
    setEditingName(campaign.name);
    setEditingFolderId(campaign.folderId ?? "root");
    setEditingVersion(campaign.version);
    setEditingInitialVersion(campaign.version);
    setEditingSystemPrompt(campaign.systemPrompt);
    setEditorTab("system");
  };

  if (!open) return null;

  const submitNewCampaign = () => {
    const name = newName.trim();
    if (!name) return;
    setError("");
    createCampaignMutation.mutate({
      name,
      folderId: newFolderId === "root" ? null : newFolderId,
      version: newVersion,
      systemPrompt: "",
    }, {
      onSuccess: () => {
        setNewName("");
        setNewFolderId("root");
        setNewVersion(0);
      },
      onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "campaign create failed"),
    });
  };

  const saveCampaign = () => {
    if (!editingCampaignId || !editingName.trim()) return;
    // An emptied prompt is refused here, visibly: the server would keep the stored one.
    const storedSystemPrompt = campaigns.data?.campaigns.find((entry) => entry.id === editingCampaignId)?.systemPrompt ?? "";
    const plan = planCampaignSave({ name: editingName, folderId: editingFolderId, version: editingVersion, initialVersion: editingInitialVersion, systemPrompt: editingSystemPrompt }, storedSystemPrompt);
    if (plan.kind === "refuse") { setError(plan.message); return; }
    setError("");
    updateCampaignMutation.mutate({
      campaignId: editingCampaignId,
      payload: plan.payload,
    }, {
      onSuccess: (next) => {
        void queryClient.invalidateQueries({ queryKey: ["campaign-versions", editingCampaignId] });
        // Re-seed from the SAVED campaign — blanking the fields while the
        // editor stayed open left a blank name, version 0, and a permanently
        // disabled Save button until the campaign was re-clicked.
        const updated = next.campaigns.find((entry) => entry.id === editingCampaignId);
        if (updated) selectCampaign(updated);
      },
      // Saves are last-write-wins across browsers — the campaign PATCH has no
      // updatedAt precondition, so there is no 409 to translate.
      onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "campaign update failed"),
    });
  };

  // Measured as the server does (trimmed).
  const wizardTemplateLength = wizardExampleSystemPrompt.trim().length;
  const wizardTemplateTooLong = wizardTemplateLength > WIZARD_TEMPLATE_MAX ? overLimitMessage("The example prompt", wizardTemplateLength, WIZARD_TEMPLATE_MAX) : null;

  const saveWizardTemplateState = () => {
    if (wizardTemplateTooLong) return;
    setError("");
    const submitted = wizardExampleSystemPrompt;
    updateWizardTemplatesMutation.mutate({
      exampleSystemPrompt: submitted,
    }, {
      // The saved text is the new seed, so the next refetch is not "dirty".
      onSuccess: () => { setWizardTemplateSeed(submitted); setWizardTemplateServerChanged(false); },
      onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "wizard template update failed"),
    });
  };

  const wizardRunTooLong = wizardBrief.trim().length > WIZARD_RUN_MAX.brief
    ? overLimitMessage("The brief", wizardBrief.trim().length, WIZARD_RUN_MAX.brief)
    : wizardTranscript.trim().length > WIZARD_RUN_MAX.transcript
      ? overLimitMessage("The transcript", wizardTranscript.trim().length, WIZARD_RUN_MAX.transcript)
      : null;

  const submitWizardRun = () => {
    if (wizardRunTooLong) return;
    const campaignName = wizardCampaignName.trim();
    const brief = wizardBrief.trim();
    const transcript = wizardTranscript.trim();
    if (!campaignName || (!brief && !transcript)) return;
    setError("");
    enqueueWizardMutation.mutate({
      campaignName,
      modelId: wizardModelId,
      brief,
      wizardTranscript: transcript,
    }, {
      onSuccess: () => {
        setWizardCampaignName("");
        setWizardBrief("");
        setWizardTranscript("");
        void queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
      },
      onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "wizard run create failed"),
    });
  };

  const selectedCampaign = campaigns.data?.campaigns.find((c) => c.id === selectedCampaignId) ?? null;
  // Detect unsaved editor edits relative to the loaded campaign.
  const editorDirty = Boolean(
    selectedCampaign
    && editingCampaignId === selectedCampaign.id
    && (
      editingName !== selectedCampaign.name
      || (editingFolderId === "root" ? null : editingFolderId) !== (selectedCampaign.folderId ?? null)
      || editingVersion !== editingInitialVersion
      || editingSystemPrompt !== selectedCampaign.systemPrompt
    ),
  );
  // Switching rows: guard against silently discarding unsaved edits.
  const requestSelectCampaign = (campaign: CampaignsListResponse["campaigns"][number]) => {
    if (campaign.id === selectedCampaignId) return;
    if (editorDirty) { setPendingSwitchCampaign(campaign); return; }
    selectCampaign(campaign);
  };
  // A restore re-seeds the editor from the restored campaign (restoreVersionMutation.onSuccess), which discards
  // unsaved edits in any field: ask first while there are some; without edits it restores at once.
  // While it runs the editor's fields are held, since the re-seed would overwrite anything typed meanwhile, and the
  // row being restored says so. Its result replaces an earlier error, as a save's does.
  const startRestore = (request: { campaignId: string; version: number; archiveId: string | null }) => {
    setError("");
    restoreVersionMutation.mutate(request);
  };
  const requestRestore = (request: { campaignId: string; version: number; archiveId: string | null }) => {
    if (editorDirty) { setPendingRestore(request); return; }
    startRestore(request);
  };
  // Only the restored campaign's editor is re-seeded, so only it is held.
  const restoring = restoreVersionMutation.isPending && restoreVersionMutation.variables?.campaignId === editingCampaignId
    ? restoreVersionMutation.variables
    : null;
  const editorTabLabels: Record<typeof editorTab, string> = { system: "System Prompt", pipeline: "Pipeline", history: "History" };

  return (
    <Dialog open onClose={onClose} label="Campaigns" size="panel" className="campaign-dialog" bodyClassName="dialog-body-flush" hideClose>
        <div className="cc-topbar">
          <Icon name="book" size={16} />
          <span className="cc-title">Campaign Manager</span>
          <div className="campaign-tabs" style={{ marginBottom: 0, borderBottom: "none", flex: 1 }}>
            <button type="button" className={`campaign-tab${topTab === "campaigns" ? " active" : ""}`} onClick={() => setTopTab("campaigns")}>Campaigns{campaigns.data ? ` (${campaigns.data.campaigns.length})` : ""}</button>
            <button type="button" className={`campaign-tab${topTab === "wizard" ? " active" : ""}`} onClick={() => setTopTab("wizard")}>Wizard</button>
          </div>
          <button type="button" className="ghost-button" onClick={onClose} title="Close"><Icon name="x" size={16} /></button>
        </div>

        {error ? <div style={{ padding: "4px 12px" }}><p className="error">{error}</p></div> : null}

        {topTab === "campaigns" ? (
          <div className="campaign-layout">
            {/* Campaign list sidebar */}
            <div className="campaign-list">
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button type="button" className="secondary-button" style={{ fontSize: 11 }} onClick={() => setCreating(true)}>+ New</button>
              </div>

              {creating ? (
                <div className="campaign-create-form">
                  <input placeholder="Campaign name" value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitNewCampaign(); }} />
                  <select value={newFolderId} onChange={(event) => setNewFolderId(event.target.value)}>
                    <option value="root">No folder</option>
                    {availableFolderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
                  </select>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <label style={{ fontSize: 10, color: "var(--text2)", whiteSpace: "nowrap" }}>Version:</label>
                    <NumericInput min={0} value={newVersion} onChange={(v) => setNewVersion(v)} style={{ width: 50 }} />
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button type="button" className="secondary-button" style={{ fontSize: 10 }} onClick={submitNewCampaign} disabled={!newName.trim() || busy}>Create</button>
                    <button type="button" className="ghost-button" style={{ fontSize: 10 }} onClick={() => { setCreating(false); setNewName(""); setNewVersion(0); }}>Cancel</button>
                  </div>
                </div>
              ) : null}

              {campaigns.isLoading ? <p className="muted small-copy">Loading...</p> : null}
              {/* A failed read is not an empty account: it says so, with Retry, above any rows already loaded. */}
              <QueryError query={campaigns} label="Unable to load campaigns" />
              {(campaigns.data?.campaigns ?? []).map((campaign) => (
                <div
                  key={campaign.id}
                  className={`campaign-item${selectedCampaignId === campaign.id ? " active" : ""}`}
                  onClick={() => requestSelectCampaign(campaign)}
                >
                  <div className="campaign-item-name">{campaign.name}</div>
                  <div className="campaign-item-meta">
                    v{campaign.version} · {campaign.systemPrompt ? <Icon name="check" size={12} /> : "—"} prompt
                  </div>
                </div>
              ))}
              {campaigns.isSuccess && !campaigns.data.campaigns.length && !creating ? <div className="panel-empty-state"><img className="empty-state-art empty-state-art-md" src="/brand/empty-campaign.webp" alt="" width="720" height="720" loading="lazy" /><p className="muted small-copy">No campaigns yet.</p></div> : null}
            </div>

            {/* Campaign editor */}
            <div className="campaign-editor">
              {!selectedCampaign ? <div className="campaign-empty">Select a campaign to edit</div> : (
                <>
                  <div className="campaign-editor-header">
                    <input className="campaign-name-input" value={editingName} onChange={(event) => setEditingName(event.target.value)} readOnly={restoring != null} />
                    <select value={editingFolderId} onChange={(event) => setEditingFolderId(event.target.value)} disabled={restoring != null} style={{ fontSize: 11 }}>
                      <option value="root">No folder</option>
                      {availableFolderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
                    </select>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <label style={{ fontSize: 10, color: "var(--text2)" }}>v</label>
                      <NumericInput min={0} value={editingVersion} onChange={(v) => setEditingVersion(v)} disabled={restoring != null} style={{ width: 45, fontSize: 11, padding: "2px 4px" }} />
                    </div>
                  </div>

                  <div className="campaign-tabs">
                    {(Object.entries(editorTabLabels) as [typeof editorTab, string][]).map(([key, label]) => (
                      <button key={key} type="button" className={`campaign-tab${editorTab === key ? " active" : ""}`} onClick={() => setEditorTab(key)}>{label}</button>
                    ))}
                  </div>


                  {editorTab === "system" ? (
                    <textarea
                      className="campaign-textarea"
                      value={editingSystemPrompt}
                      onChange={(event) => setEditingSystemPrompt(event.target.value)}
                      readOnly={restoring != null}
                      placeholder="Paste System Prompt content here..."
                    />
                  ) : null}

                  {editorTab === "pipeline" ? (
                    <div className="campaign-pipeline-section" style={{ flex: 1 }}>
                      <div className="stack stack-tight">
                        <p className="muted small-copy">Campaign Audit reconciles the lorebook against the whole story from message 1 — fixes auto-apply behind an adversarial check; every write is revisioned.</p>
                        <button type="button" onClick={() => setAuditDialogOpen(true)} style={{ alignSelf: "flex-start" }}>
                          <Icon name="search" size={14} /> Campaign Audit…
                        </button>
                      </div>
                      <CampaignPipelineStatus
                        campaignId={selectedCampaign.id}
                        campaignName={selectedCampaign.name}
                        busy={busy}
                        onCancel={(runId) => cancelPipelineMutation.mutate({ campaignId: selectedCampaign.id, runId })}
                      />
                      <CampaignAuditDialog
                        open={auditDialogOpen}
                        onClose={() => setAuditDialogOpen(false)}
                        campaignId={selectedCampaign.id}
                        campaignName={selectedCampaign.name}
                        defaultModelId={availableChatModels.find((m) => m.id === CONTRACT_AUDIT_MODEL_DEFAULT)?.id ?? availableChatModels[0]?.id ?? ""}
                        availableModels={availableChatModels}
                        config={providerConfig.data}
                      />
                    </div>
                  ) : null}

                  {editorTab === "history" ? (
                    <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
                      <CampaignVersionHistory
                        campaignId={selectedCampaign.id}
                        busy={busy}
                        restoring={restoring}
                        onRestore={(version, archiveId) => requestRestore({ campaignId: selectedCampaign.id, version, archiveId })}
                      />
                    </div>
                  ) : null}

                  <div className="campaign-actions">
                    <button type="button" className="secondary-button" onClick={saveCampaign} disabled={!editingName.trim() || busy} style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>Save</button>
                    <button type="button" className="secondary-button" onClick={() => startSessionMutation.mutate(selectedCampaign.id)} disabled={busy} style={{ borderColor: "var(--green)", color: "var(--green)" }}>Start Session</button>
                    {confirmDeleteCampaign ? (
                      <>
                        <button type="button" className="danger-button" onClick={() => { deleteCampaignMutation.mutate(selectedCampaign.id); setConfirmDeleteCampaign(false); }} disabled={busy}>Confirm delete</button>
                        <button type="button" className="ghost-button" onClick={() => setConfirmDeleteCampaign(false)}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" className="secondary-button" onClick={() => setConfirmDeleteCampaign(true)} disabled={busy} style={{ borderColor: "var(--red, #f85149)", color: "var(--red, #f85149)" }}>Delete</button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          /* Wizard tab */
          <div className="campaign-wizard-section">
            <div className="stack">
              <div className="section-head">
                <h4 style={{ margin: 0 }}>Template Library</h4>
                <span className="muted small-copy">{wizardTemplates.data?.templates.updatedAt ? `Updated ${new Date(wizardTemplates.data.templates.updatedAt).toLocaleString()}` : "Shared per user"}</span>
              </div>
              {wizardTemplates.isLoading ? <p className="muted small-copy">Loading wizard templates...</p> : null}
              <AutoTextarea aria-label="Wizard example system prompt" placeholder="Example system prompt" minRows={3} maxRows={16} value={wizardExampleSystemPrompt} onChange={(event) => setWizardExampleSystemPrompt(event.target.value)} />
              {wizardTemplateTooLong ? <p className="error small-copy" role="alert">{wizardTemplateTooLong}</p> : null}
              {wizardTemplateServerChanged && wizardTemplates.data ? (
                <p className="muted small-copy" role="status">
                  This template changed on the server while you were editing — Save Templates will overwrite it.{" "}
                  <button type="button" className="ghost-button" style={{ fontSize: 11, padding: "0 4px" }} onClick={() => { const incoming = wizardTemplates.data!.templates.exampleSystemPrompt; setWizardExampleSystemPrompt(incoming); setWizardTemplateSeed(incoming); setWizardTemplateServerChanged(false); }}>Load the server version (discards your edits)</button>
                </p>
              ) : null}
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" onClick={saveWizardTemplateState} disabled={busy || wizardTemplateTooLong != null} style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>Save Templates</button>
              </div>
            </div>

            <div className="stack" style={{ marginTop: 16 }}>
              <div className="section-head">
                <h4 style={{ margin: 0 }}>Generate Campaign</h4>
                {/* A count only once a read has landed: a failed first read is not "0 runs" (as in the campaign list). */}
                {wizardRuns.data ? <span className="muted small-copy">{wizardRuns.data.runs.length} runs</span> : null}
              </div>
              <input aria-label="Wizard campaign name" placeholder="Campaign name (e.g. Ashenmoor)" maxLength={WIZARD_RUN_MAX.campaignName} value={wizardCampaignName} onChange={(event) => setWizardCampaignName(event.target.value)} />
              <select aria-label="Wizard model" value={wizardModelId} onChange={(event) => setWizardModelId(event.target.value)}>
                {availableChatModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
              <AutoTextarea aria-label="Wizard campaign brief" placeholder="Optional short summary of the setting, premise, cast, tone, and main character." minRows={3} maxRows={16} value={wizardBrief} onChange={(event) => setWizardBrief(event.target.value)} />
              <AutoTextarea aria-label="Wizard transcript" placeholder="Paste the wizard conversation transcript here. If blank, the brief above will be used." minRows={3} maxRows={16} value={wizardTranscript} onChange={(event) => setWizardTranscript(event.target.value)} />
              {wizardRunTooLong ? <p className="error small-copy" role="alert">{wizardRunTooLong}</p> : null}
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" onClick={submitWizardRun} disabled={!wizardCampaignName.trim() || (!wizardBrief.trim() && !wizardTranscript.trim()) || !wizardModelId || busy || wizardRunTooLong != null} title={wizardModelId ? undefined : "No chat model is available — add a provider key first"} style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>Run Wizard</button>
              </div>
              <WizardRunStatusPanel
                runs={wizardRuns}
                busy={busy}
                onOpenReview={(runId) => setReviewingWizardRunId(runId)}
                onRetry={(runId) => retryWizardMutation.mutate(runId)}
                onCancel={(runId) => cancelWizardMutation.mutate(runId)}
                onDismiss={(runId) => dismissWizardMutation.mutate(runId)}
              />
            </div>
          </div>
        )}

        <WizardReviewDialog
          open={reviewingWizardRun != null}
          run={reviewingWizardRun}
          busy={busy}
          onClose={() => setReviewingWizardRunId(null)}
          onApprove={(runId, payload) => approveWizardMutation.mutate({ runId, payload }, { onSuccess: () => setReviewingWizardRunId(null) })}
          onRetry={(runId) => retryWizardMutation.mutate(runId, { onSuccess: () => setReviewingWizardRunId(null) })}
          onCancel={(runId) => cancelWizardMutation.mutate(runId, { onSuccess: () => setReviewingWizardRunId(null) })}
        />

        {pendingSwitchCampaign ? (
          <Dialog
            open
            onClose={() => setPendingSwitchCampaign(null)}
            label="Discard unsaved changes"
            eyebrow="Unsaved Changes"
            title={selectedCampaign?.name ?? "This campaign"}
            icon="alert"
            size="sm"
            zIndex={300}
            footer={<>
                <button type="button" className="secondary-button" onClick={() => setPendingSwitchCampaign(null)}>Keep Editing</button>
                <button type="button" className="danger-button" onClick={() => { const next = pendingSwitchCampaign; setPendingSwitchCampaign(null); selectCampaign(next); }}>Discard &amp; Switch</button>
            </>}
          >
            <p className="muted">You have unsaved edits in this campaign. Switching to &quot;{pendingSwitchCampaign.name}&quot; will discard them.</p>
          </Dialog>
        ) : null}

        {pendingRestore ? (
          <Dialog
            open
            onClose={() => setPendingRestore(null)}
            label="Restore campaign version"
            eyebrow="Unsaved Changes"
            title={`Restore version ${pendingRestore.version}?`}
            icon="alert"
            size="sm"
            zIndex={300}
            footer={<>
                <button type="button" className="secondary-button" onClick={() => setPendingRestore(null)}>Keep editing</button>
                <button type="button" className="danger-button" disabled={busy} onClick={() => { const request = pendingRestore; setPendingRestore(null); startRestore(request); }}>Restore</button>
            </>}
          >
            <p className="muted">Your unsaved edits to this campaign will be discarded.</p>
          </Dialog>
        ) : null}
    </Dialog>
  );
}

// Exported for its render test (Cancel Wizard asks first).
export function WizardRunStatusPanel({
  runs,
  busy,
  onOpenReview,
  onRetry,
  onCancel,
  onDismiss,
}: {
  runs: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getWizardRuns>>>>;
  busy: boolean;
  onOpenReview: (runId: string) => void;
  onRetry: (runId: string) => void;
  onCancel: (runId: string) => void;
  onDismiss: (runId: string) => void;
}) {
  const latest = runs.data?.runs[0] ?? null;
  // Cancel Wizard asks first, as the Pipeline tab's Cancel Run does.
  const [confirming, setConfirming] = useState<CancelWizardTarget | null>(null);

  // A failed read says why with Retry: alone on a first read, above the last read's run on a re-read.
  // "No wizard runs yet." is claimed only from a read that found none.
  return (
    <div className="stack stack-tight">
      <p className="muted small-copy">Latest Wizard Run</p>
      {runs.isLoading ? <p className="muted small-copy">Loading wizard runs...</p> : null}
      <QueryError query={runs} label={runs.data ? "Unable to refresh the wizard runs (showing the last read)" : "Unable to load the wizard runs"} />
      {runs.data && !latest ? <p className="muted small-copy">No wizard runs yet.</p> : null}
      {latest ? (
        <div className="placeholder-card stack stack-tight">
          <div className="section-head">
            <strong>{latest.review.campaignName}</strong>
            <span className="muted small-copy">{formatWizardStatus(latest.status)}</span>
          </div>
          <p className="muted small-copy">Requested {new Date(latest.requestedAt).toLocaleString()}</p>
          {latest.approvedAt ? <p className="muted small-copy">Approved {new Date(latest.approvedAt).toLocaleString()}</p> : null}
          <p className="message-body">{latest.summary || "Wizard worker is preparing campaign documents."}</p>
          {latest.error ? <p className="error">{latest.error}</p> : null}
          <div className="row gap-sm">
            <button type="button" className="secondary-button" onClick={() => onOpenReview(latest.id)}>
              Open Review
            </button>
            {(latest.status === "queued" || latest.status === "running") ? (
              <button type="button" className="danger-button" onClick={() => setConfirming(cancelWizardTargetOf(latest))} disabled={busy}>Cancel Wizard</button>
            ) : null}
            {(latest.status === "completed" || latest.status === "failed" || latest.status === "canceled") && !latest.approvedAt ? (
              <button type="button" className="secondary-button" onClick={() => onRetry(latest.id)} disabled={busy}>Retry Wizard</button>
            ) : null}
            {(latest.status === "completed" || latest.status === "failed" || latest.status === "canceled") && !latest.approvedAt ? (
              <button type="button" className="danger-button" onClick={() => onDismiss(latest.id)} disabled={busy}>Dismiss</button>
            ) : null}
          </div>
        </div>
      ) : null}
      <CancelWizardDialog
        target={confirming}
        busy={busy}
        onConfirm={() => { if (confirming) onCancel(confirming.runId); setConfirming(null); }}
        onKeep={() => setConfirming(null)}
      />
    </div>
  );
}

// Exported for its render test.
export function CampaignPipelineStatus({
  campaignId,
  campaignName,
  busy,
  onCancel,
}: {
  campaignId: string;
  campaignName: string;
  busy: boolean;
  onCancel: (runId: string) => void;
}) {
  const runs = useQuery({
    queryKey: ["pipeline-runs", campaignId],
    // The view shows the newest run only; the full history is not needed for it (2026-09-30).
    queryFn: () => getPipelineRuns(campaignId, { limit: 1 }),
    refetchInterval: (query) => {
      const status = query.state.data?.runs[0]?.status;
      return status === "queued" || status === "running" ? 2_000 : false;
    },
  });
  const latest = runs.data?.runs[0] ?? null;
  // Cancel Run asks first, as in the activity bar. A refusal shows in the panel's error line.
  const [confirming, setConfirming] = useState<CancelRunTarget | null>(null);

  // A failed read says why with Retry, as the Wizard tab's does.
  return (
    <div className="stack stack-tight">
      <p className="muted small-copy">Run history</p>
      {runs.isLoading ? <p className="muted small-copy">Loading pipeline runs...</p> : null}
      <QueryError query={runs} label={runs.data ? "Unable to refresh the pipeline runs (showing the last read)" : "Unable to load the pipeline runs"} />
      {runs.data && !latest ? <p className="muted small-copy">No pipeline runs yet.</p> : null}
      {latest ? (
        <>
          <div className="pipeline-actions-bar">
            <span className="muted small-copy">{formatPipelineStatus(latest.status)}</span>
            {(latest.status === "queued" || latest.status === "running") ? (
              <button type="button" className="danger-button" onClick={() => setConfirming({ campaignId, campaignName, runId: latest.id, kind: latest.kind ?? null })} disabled={busy}>Cancel Run</button>
            ) : null}
          </div>
          <div className="placeholder-card stack stack-tight">
            <p className="muted small-copy">
              Requested {new Date(latest.requestedAt).toLocaleString()}
              {latest.completedAt ? <> · finished {new Date(latest.completedAt).toLocaleString()}</> : null}
            </p>
            {/* Summary + error are the run's real output. The retired
                "Show Details" step cards (Deep Analysis / Lorebook Refresh /
                System Prompt Update — always "Pending") described the sunset
                campaign_review kind. */}
            <p className="message-body">{latest.summary || "Pipeline worker is preparing this run."}</p>
            {latest.error ? <p className="error">{latest.error}</p> : null}
          </div>
        </>
      ) : null}
      <CancelRunDialog
        target={confirming}
        busy={busy}
        onConfirm={() => { if (confirming) onCancel(confirming.runId); setConfirming(null); }}
        onKeep={() => setConfirming(null)}
      />
    </div>
  );
}

// Exported for its render test.
export function CampaignVersionHistory({
  campaignId,
  busy,
  restoring,
  onRestore,
}: {
  campaignId: string;
  busy: boolean;
  /** The restore in flight, if any: its row reads "Restoring…". */
  restoring: { version: number; archiveId: string | null } | null;
  // `archiveId` is the row's own id: the number alone can match another row.
  onRestore: (version: number, archiveId: string | null) => void;
}) {
  const [previewVersion, setPreviewVersion] = useState<{ version: number; field: string; content: string } | null>(null);
  // "Diff vs previous": adjacent rows in the (newest-first) list.
  const [diffVersions, setDiffVersions] = useState<{ label: string; oldText: string; newText: string } | null>(null);
  const versions = useQuery({
    queryKey: ["campaign-versions", campaignId],
    queryFn: () => getCampaignVersions(campaignId),
  });

  // A failed read says why with Retry: alone on a first read, and on a re-read above
  // the rows already loaded, which a bare "Campaign history request failed" used to replace.
  if (!versions.data) {
    return versions.isError
      ? <div style={{ padding: 12 }}><QueryError query={versions} label="Unable to load the campaign history" /></div>
      : <p className="muted small-copy" style={{ padding: 12 }}>Loading history...</p>;
  }
  const refreshFailure = versions.isError
    ? <div style={{ padding: "6px 8px" }}><QueryError query={versions} label="Unable to refresh the campaign history (showing the last read)" /></div>
    : null;
  if (!versions.data.versions.length) return <>{refreshFailure}<div style={{ fontSize: 11, color: "var(--text2)", padding: 12 }}>No version history yet. Versions are archived whenever the system prompt is changed or restored.</div></>;

  if (diffVersions) {
    return (
      <div style={{ padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>System Prompt diff — {diffVersions.label}</span>
          <button type="button" className="secondary-button" style={{ fontSize: 10 }} onClick={() => setDiffVersions(null)}>← Back</button>
        </div>
        {diffVersions.oldText === diffVersions.newText
          ? <p className="muted small-copy" style={{ margin: 0 }}>No system prompt changes between these versions.</p>
          : <DiffView oldText={diffVersions.oldText} newText={diffVersions.newText} />}
      </div>
    );
  }

  if (previewVersion) {
    return (
      <div style={{ padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Version {previewVersion.version} — {previewVersion.field}</span>
          <button type="button" className="secondary-button" style={{ fontSize: 10 }} onClick={() => setPreviewVersion(null)}>← Back</button>
        </div>
        <pre style={{ fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", color: "var(--text)", margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>{previewVersion.content}</pre>
      </div>
    );
  }

  return (
    <div style={{ padding: 4 }}>
      {refreshFailure}
      {versions.data.versions.map((version, idx, all) => {
        const previous = all[idx + 1];
        const isSnapshot = Boolean(version.label);
        const tagColor = version.isCurrent ? "var(--green)" : isSnapshot ? "var(--text2)" : "var(--accent)";
        const tagLabel = isSnapshot ? "snap" : `v${version.version}`;
        const meta = isSnapshot
          ? `${version.label} · snapshot`
          : `${new Date(version.createdAt).toLocaleString()}${version.isCurrent ? " (current)" : ""}`;
        return (
          <div key={`${campaignId}-${version.version}-${version.createdAt}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderBottom: "1px solid var(--surface-border)", opacity: isSnapshot ? 0.85 : 1 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: tagColor, minWidth: 30 }}>{tagLabel}</span>
            <span style={{ fontSize: 10, color: "var(--text2)", flex: 1 }} title={isSnapshot ? `captured ${new Date(version.createdAt).toLocaleString()}` : undefined}>{meta}</span>
            {version.systemPrompt ? <button type="button" className="secondary-button" style={{ fontSize: 10, padding: "2px 6px" }} onClick={() => setPreviewVersion({ version: version.version, field: "System Prompt", content: version.systemPrompt || "" })}>Prompt</button> : null}
            {previous ? (
              <button
                type="button"
                className="secondary-button"
                style={{ fontSize: 10, padding: "2px 6px" }}
                title="Diff this version's system prompt against the previous version"
                onClick={() => setDiffVersions({
                  label: `${previous.label ? "snap" : `v${previous.version}`} → ${isSnapshot ? "snap" : `v${version.version}`}`,
                  oldText: previous.systemPrompt,
                  newText: version.systemPrompt,
                })}
              >
                Diff
              </button>
            ) : null}
            {!version.isCurrent && !isSnapshot ? <button type="button" className="secondary-button" style={{ fontSize: 10, padding: "2px 6px", color: "var(--amber)", borderColor: "var(--amber)" }} onClick={() => onRestore(version.version, version.id ?? null)} disabled={busy}>{restoring && restoring.version === version.version && restoring.archiveId === (version.id ?? null) ? "Restoring…" : "Restore"}</button> : null}
          </div>
        );
      })}
    </div>
  );
}
