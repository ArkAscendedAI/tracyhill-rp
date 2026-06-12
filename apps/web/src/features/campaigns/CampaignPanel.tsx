import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CampaignsListResponse, PipelineRun, PipelineRunStatus, WizardRunStatus } from "@tracyhill-rp/contracts";
import { EMBEDDING_MODELS } from "@tracyhill-rp/model-catalog";

import { NumericInput } from "../../shared/ui/NumericInput";

import { buildAvailableChatModels, getProviderKeys } from "../auth/providerKeyApi";
import { createCampaign, deleteCampaign, getCampaignVersions, restoreCampaignVersion, updateCampaign } from "./campaignApi";
import { abandonPipelineRun, approvePipelineRun, cancelPipelineRun, getPipelineRuns, enqueuePipelineRun, retryPipelineRun } from "../pipeline/pipelineApi";
import { PipelineReviewDetails } from "../pipeline/PipelineReviewDetails";
import { approveWizardRun, cancelWizardRun, enqueueWizardRun, getWizardRuns, getWizardTemplates, retryWizardRun, updateWizardTemplates } from "../wizard/wizardApi";
import { WizardReviewDialog } from "../wizard/WizardReviewDialog";
import { startSessionFromCampaign } from "../workspace/workspaceApi";
import { flattenFolderOptions, getFolderPathLabel } from "../workspace/folderTree";
import { useWorkspaceState } from "../workspace/useWorkspaceState";
import { useCampaigns } from "./useCampaigns";

type CampaignPanelProps = {
  open: boolean;
  onClose: () => void;
};

export function CampaignPanel({ open, onClose }: CampaignPanelProps) {
  const queryClient = useQueryClient();
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
  const [creating, setCreating] = useState(false);
  const [topTab, setTopTab] = useState<"campaigns" | "wizard">("campaigns");
  const [editorTab, setEditorTab] = useState<"system" | "context" | "pipeline" | "history">("system");
  const [newName, setNewName] = useState("");
  const [newFolderId, setNewFolderId] = useState("root");
  const [newPipelineModelId, setNewPipelineModelId] = useState(availableChatModels[0]?.id ?? "claude-opus-4-7");
  const [newVersion, setNewVersion] = useState(0);
  const [newSystemPrompt, setNewSystemPrompt] = useState("");
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingFolderId, setEditingFolderId] = useState("root");
  const [editingPipelineModelId, setEditingPipelineModelId] = useState(availableChatModels[0]?.id ?? "claude-opus-4-7");
  const [editingVersion, setEditingVersion] = useState(0);
  const [editingInitialVersion, setEditingInitialVersion] = useState(0);
  const [editingSystemPrompt, setEditingSystemPrompt] = useState("");
  const [editingContextDefaults, setEditingContextDefaults] = useState<Record<string, unknown>>({});
  const [wizardExampleSystemPrompt, setWizardExampleSystemPrompt] = useState("");
  const [wizardCampaignName, setWizardCampaignName] = useState("");
  const [wizardModelId, setWizardModelId] = useState(availableChatModels[0]?.id ?? "claude-opus-4-7");
  const [wizardBrief, setWizardBrief] = useState("");
  const [wizardTranscript, setWizardTranscript] = useState("");
  const [reviewingWizardRunId, setReviewingWizardRunId] = useState<string | null>(null);
  const [error, setError] = useState("");

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
    setWizardExampleSystemPrompt(wizardTemplates.data.templates.exampleSystemPrompt);
  }, [wizardTemplates.data]);

  useEffect(() => {
    if (!availableChatModels.length) return;
    // New-campaign/wizard pickers may normalize to a valid default, but the
    // EDITOR must never silently rewrite an existing campaign's model — a
    // retired/custom id was swapped to availableChatModels[0] and Save
    // persisted the swap with no warning. The select below renders unknown
    // ids as an explicit "(unavailable)" option instead.
    if (!availableChatModels.some((model) => model.id === newPipelineModelId)) setNewPipelineModelId(availableChatModels[0]!.id);
    if (!availableChatModels.some((model) => model.id === wizardModelId)) setWizardModelId(availableChatModels[0]!.id);
  }, [availableChatModels, newPipelineModelId, wizardModelId]);

  const setCampaignState = (next: CampaignsListResponse) => {
    queryClient.setQueryData(["campaigns"], next);
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
    mutationFn: ({ campaignId, version }: { campaignId: string; version: number }) => restoreCampaignVersion(campaignId, version),
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
      queryClient.setQueryData(["workspace-state"], next);
    },
    onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "start session failed"),
  });
  const enqueuePipelineMutation = useMutation({
    mutationFn: ({ campaignId, body }: { campaignId: string; body?: { creativeModelId?: string } }) => enqueuePipelineRun(campaignId, body),
    onSuccess: (next) => {
      queryClient.setQueryData(["pipeline-runs", next.campaignId], next);
      void queryClient.invalidateQueries({ queryKey: ["pipeline-active"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
    },
    onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "pipeline enqueue failed"),
  });
  const approvePipelineMutation = useMutation({
    mutationFn: ({ campaignId, runId, startSession }: { campaignId: string; runId: string; startSession?: boolean }) => approvePipelineRun(campaignId, runId, startSession),
    onSuccess: (next) => {
      queryClient.setQueryData(["pipeline-runs", next.campaignId], next);
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
      void queryClient.invalidateQueries({ queryKey: ["pipeline-active"] });
    },
    onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "pipeline approve failed"),
  });
  const cancelPipelineMutation = useMutation({
    mutationFn: ({ campaignId, runId }: { campaignId: string; runId: string }) => cancelPipelineRun(campaignId, runId),
    onSuccess: (next) => {
      queryClient.setQueryData(["pipeline-runs", next.campaignId], next);
      void queryClient.invalidateQueries({ queryKey: ["pipeline-active"] });
    },
    onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "pipeline cancel failed"),
  });
  const retryPipelineMutation = useMutation({
    mutationFn: ({ campaignId, runId, fromStep }: { campaignId: string; runId: string; fromStep?: "fromLorebookRefresh" | "fromSysprompt" }) => retryPipelineRun(campaignId, runId, fromStep),
    onSuccess: (next) => {
      queryClient.setQueryData(["pipeline-runs", next.campaignId], next);
      void queryClient.invalidateQueries({ queryKey: ["pipeline-active"] });
    },
    onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "pipeline retry failed"),
  });
  const abandonPipelineMutation = useMutation({
    mutationFn: ({ campaignId, runId }: { campaignId: string; runId: string }) => abandonPipelineRun(campaignId, runId),
    onSuccess: (next) => {
      queryClient.setQueryData(["pipeline-runs", next.campaignId], next);
      void queryClient.invalidateQueries({ queryKey: ["pipeline-active"] });
    },
    onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "pipeline abandon failed"),
  });
  const updateWizardTemplatesMutation = useMutation({
    mutationFn: updateWizardTemplates,
    onSuccess: (next) => {
      queryClient.setQueryData(["wizard-templates"], next);
    },
  });
  const enqueueWizardMutation = useMutation({
    mutationFn: enqueueWizardRun,
    onSuccess: (next) => {
      queryClient.setQueryData(["wizard-runs"], next);
    },
  });
  const approveWizardMutation = useMutation({
    mutationFn: ({ runId, payload }: { runId: string; payload: Parameters<typeof approveWizardRun>[1] }) => approveWizardRun(runId, payload),
    onSuccess: (next) => {
      queryClient.setQueryData(["wizard-runs"], next);
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
      void queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
    },
  });
  const retryWizardMutation = useMutation({
    mutationFn: retryWizardRun,
    onSuccess: (next) => {
      queryClient.setQueryData(["wizard-runs"], next);
      void queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
    },
  });
  const cancelWizardMutation = useMutation({
    mutationFn: cancelWizardRun,
    onSuccess: (next) => {
      queryClient.setQueryData(["wizard-runs"], next);
      void queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
    },
  });

  const busy = createCampaignMutation.isPending
    || updateCampaignMutation.isPending
    || deleteCampaignMutation.isPending
    || restoreVersionMutation.isPending
    || startSessionMutation.isPending
    || enqueuePipelineMutation.isPending
    || approvePipelineMutation.isPending
    || cancelPipelineMutation.isPending
    || retryPipelineMutation.isPending
    || abandonPipelineMutation.isPending
    || updateWizardTemplatesMutation.isPending
    || enqueueWizardMutation.isPending
    || approveWizardMutation.isPending
    || retryWizardMutation.isPending
    || cancelWizardMutation.isPending;
  const reviewingWizardRun = wizardRuns.data?.runs.find((run) => run.id === reviewingWizardRunId) ?? null;

  if (!open) return null;

  const submitNewCampaign = () => {
    const name = newName.trim();
    if (!name) return;
    setError("");
    createCampaignMutation.mutate({
      name,
      folderId: newFolderId === "root" ? null : newFolderId,
      pipelineModelId: newPipelineModelId,
      version: newVersion,
      systemPrompt: newSystemPrompt,
    }, {
      onSuccess: () => {
        setNewName("");
        setNewFolderId("root");
        setNewPipelineModelId(availableChatModels[0]?.id ?? "claude-opus-4-7");
        setNewVersion(0);
        setNewSystemPrompt("");
      },
      onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "campaign create failed"),
    });
  };

  const selectCampaign = (campaign: CampaignsListResponse["campaigns"][number]) => {
    setSelectedCampaignId(campaign.id);
    setEditingCampaignId(campaign.id);
    setEditingName(campaign.name);
    setEditingFolderId(campaign.folderId ?? "root");
    setEditingPipelineModelId(campaign.pipelineModelId);
    setEditingVersion(campaign.version);
    setEditingInitialVersion(campaign.version);
    setEditingSystemPrompt(campaign.systemPrompt);
    setEditingContextDefaults(campaign.contextDefaults ?? {});
    setEditorTab("system");
  };

  const saveCampaign = () => {
    if (!editingCampaignId || !editingName.trim()) return;
    setError("");
    updateCampaignMutation.mutate({
      campaignId: editingCampaignId,
      payload: {
        name: editingName.trim(),
        folderId: editingFolderId === "root" ? null : editingFolderId,
        pipelineModelId: editingPipelineModelId,
        ...(editingVersion !== editingInitialVersion ? { version: editingVersion } : {}),
        systemPrompt: editingSystemPrompt,
        ...(Object.keys(editingContextDefaults).length > 0 ? { contextDefaults: editingContextDefaults } : {}),
      },
    }, {
      onSuccess: (next) => {
        void queryClient.invalidateQueries({ queryKey: ["campaign-versions", editingCampaignId] });
        // Re-seed from the SAVED campaign — blanking the fields while the
        // editor stayed open left a blank name, version 0, and a permanently
        // disabled Save button until the campaign was re-clicked.
        const updated = next.campaigns.find((entry) => entry.id === editingCampaignId);
        if (updated) selectCampaign(updated);
      },
      onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "campaign update failed"),
    });
  };

  const saveWizardTemplateState = () => {
    setError("");
    updateWizardTemplatesMutation.mutate({
      exampleSystemPrompt: wizardExampleSystemPrompt,
    }, {
      onError: (nextError) => setError(nextError instanceof Error ? nextError.message : "wizard template update failed"),
    });
  };

  const submitWizardRun = () => {
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
  const editorTabLabels: Record<string, string> = { system: "System Prompt", context: "Context", pipeline: "Pipeline", history: "History" };
  const editorTabFields: Record<string, string> = { system: "editingSystemPrompt" };
  const editorFieldValues: Record<string, string> = { editingSystemPrompt };
  const editorFieldSetters: Record<string, (v: string) => void> = { editingSystemPrompt: setEditingSystemPrompt };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog-card campaign-dialog" role="dialog" aria-modal="true" aria-label="Campaigns">
        <div className="cc-topbar">
          <span style={{ fontSize: 14 }}>📖</span>
          <span className="cc-title">Campaign Manager</span>
          <div className="campaign-tabs" style={{ marginBottom: 0, borderBottom: "none", flex: 1 }}>
            <button type="button" className={`campaign-tab${topTab === "campaigns" ? " active" : ""}`} onClick={() => setTopTab("campaigns")}>Campaigns ({campaigns.data?.campaigns.length ?? 0})</button>
            <button type="button" className={`campaign-tab${topTab === "wizard" ? " active" : ""}`} onClick={() => setTopTab("wizard")}>Wizard</button>
          </div>
          <button type="button" className="ghost-button" onClick={onClose} title="Close">✕</button>
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
                  <select value={newPipelineModelId} onChange={(event) => setNewPipelineModelId(event.target.value)}>
                    {availableChatModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
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
              {(campaigns.data?.campaigns ?? []).map((campaign) => (
                <div
                  key={campaign.id}
                  className={`campaign-item${selectedCampaignId === campaign.id ? " active" : ""}`}
                  onClick={() => selectCampaign(campaign)}
                >
                  <div className="campaign-item-name">{campaign.name}</div>
                  <div className="campaign-item-meta">
                    v{campaign.version} · {campaign.systemPrompt ? "✓" : "—"} prompt
                  </div>
                </div>
              ))}
              {!campaigns.isLoading && !(campaigns.data?.campaigns.length) && !creating ? <div style={{ fontSize: 11, color: "var(--text2)", padding: 8 }}>No campaigns yet.</div> : null}
            </div>

            {/* Campaign editor */}
            <div className="campaign-editor">
              {!selectedCampaign ? <div className="campaign-empty">Select a campaign to edit</div> : (
                <>
                  <div className="campaign-editor-header">
                    <input className="campaign-name-input" value={editingName} onChange={(event) => setEditingName(event.target.value)} />
                    <select value={editingFolderId} onChange={(event) => setEditingFolderId(event.target.value)} style={{ fontSize: 11 }}>
                      <option value="root">No folder</option>
                      {availableFolderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
                    </select>
                    <select value={editingPipelineModelId} onChange={(event) => setEditingPipelineModelId(event.target.value)} style={{ fontSize: 11 }}>
                      {!availableChatModels.some((model) => model.id === editingPipelineModelId) && editingPipelineModelId ? (
                        <option value={editingPipelineModelId}>{editingPipelineModelId} (unavailable)</option>
                      ) : null}
                      {availableChatModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                    </select>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <label style={{ fontSize: 10, color: "var(--text2)" }}>v</label>
                      <NumericInput min={0} value={editingVersion} onChange={(v) => setEditingVersion(v)} style={{ width: 45, fontSize: 11, padding: "2px 4px" }} />
                    </div>
                  </div>

                  <div className="campaign-tabs">
                    {(Object.entries(editorTabLabels) as [typeof editorTab, string][]).map(([key, label]) => (
                      <button key={key} type="button" className={`campaign-tab${editorTab === key ? " active" : ""}`} onClick={() => setEditorTab(key)}>{label}</button>
                    ))}
                  </div>

                  {editorTab !== "pipeline" && editorTab !== "history" && editorTab !== "context" ? (
                    <textarea
                      className="campaign-textarea"
                      value={editorFieldValues[editorTabFields[editorTab] ?? ""] ?? ""}
                      onChange={(event) => editorFieldSetters[editorTabFields[editorTab] ?? ""]?.(event.target.value)}
                      placeholder={`Paste ${editorTabLabels[editorTab]} content here...`}
                    />
                  ) : null}

                  {editorTab === "context" ? (
                    <CampaignContextDefaults
                      defaults={editingContextDefaults}
                      availableModels={availableChatModels}
                      busy={busy}
                      onChange={(next) => setEditingContextDefaults((prev) => ({ ...prev, ...next }))}
                    />
                  ) : null}

                  {editorTab === "pipeline" ? (
                    <div className="campaign-pipeline-section" style={{ flex: 1 }}>
                      <PipelineModelPicker
                        availableModels={availableChatModels}
                        defaultModelId={editingPipelineModelId}
                        busy={busy}
                        onRun={(creativeModelId) => enqueuePipelineMutation.mutate({ campaignId: selectedCampaign.id, body: { creativeModelId } })}
                      />
                      <CampaignPipelineStatus
                        campaignId={selectedCampaign.id}
                        busy={busy}
                        onApprove={(runId, startSession) => approvePipelineMutation.mutate({ campaignId: selectedCampaign.id, runId, startSession })}
                        onCancel={(runId) => cancelPipelineMutation.mutate({ campaignId: selectedCampaign.id, runId })}
                        onRetry={(runId, fromStep) => retryPipelineMutation.mutate({ campaignId: selectedCampaign.id, runId, fromStep })}
                        onAbandon={(runId) => abandonPipelineMutation.mutate({ campaignId: selectedCampaign.id, runId })}
                      />
                    </div>
                  ) : null}

                  {editorTab === "history" ? (
                    <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
                      <CampaignVersionHistory
                        campaignId={selectedCampaign.id}
                        busy={busy}
                        onRestore={(version) => restoreVersionMutation.mutate({ campaignId: selectedCampaign.id, version })}
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
              <textarea aria-label="Wizard example system prompt" placeholder="Example system prompt" value={wizardExampleSystemPrompt} onChange={(event) => setWizardExampleSystemPrompt(event.target.value)} />
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" onClick={saveWizardTemplateState} disabled={busy} style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>Save Templates</button>
              </div>
            </div>

            <div className="stack" style={{ marginTop: 16 }}>
              <div className="section-head">
                <h4 style={{ margin: 0 }}>Generate Campaign</h4>
                <span className="muted small-copy">{wizardRuns.data?.runs.length ?? 0} runs</span>
              </div>
              <input aria-label="Wizard campaign name" placeholder="Campaign name (e.g. Ashenmoor)" value={wizardCampaignName} onChange={(event) => setWizardCampaignName(event.target.value)} />
              <select aria-label="Wizard model" value={wizardModelId} onChange={(event) => setWizardModelId(event.target.value)}>
                {availableChatModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
              <textarea aria-label="Wizard campaign brief" placeholder="Optional short summary of the setting, premise, cast, tone, and main character." value={wizardBrief} onChange={(event) => setWizardBrief(event.target.value)} />
              <textarea aria-label="Wizard transcript" placeholder="Paste the wizard conversation transcript here. If blank, the brief above will be used." value={wizardTranscript} onChange={(event) => setWizardTranscript(event.target.value)} />
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" onClick={submitWizardRun} disabled={!wizardCampaignName.trim() || (!wizardBrief.trim() && !wizardTranscript.trim()) || busy} style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>Run Wizard</button>
              </div>
              <WizardRunStatusPanel
                runs={wizardRuns}
                busy={busy}
                onOpenReview={(runId) => setReviewingWizardRunId(runId)}
                onRetry={(runId) => retryWizardMutation.mutate(runId)}
                onCancel={(runId) => cancelWizardMutation.mutate(runId)}
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
      </section>
    </div>
  );
}

function WizardRunStatusPanel({
  runs,
  busy,
  onOpenReview,
  onRetry,
  onCancel,
}: {
  runs: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getWizardRuns>>>>;
  busy: boolean;
  onOpenReview: (runId: string) => void;
  onRetry: (runId: string) => void;
  onCancel: (runId: string) => void;
}) {
  const latest = runs.data?.runs[0] ?? null;

  return (
    <div className="stack stack-tight">
      <p className="muted small-copy">Latest Wizard Run</p>
      {runs.isLoading ? <p className="muted small-copy">Loading wizard runs...</p> : null}
      {runs.isError ? <p className="error">wizard run request failed</p> : null}
      {!runs.isLoading && !latest ? <p className="muted small-copy">No wizard runs yet.</p> : null}
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
              <button type="button" className="danger-button" onClick={() => onCancel(latest.id)} disabled={busy}>Cancel Wizard</button>
            ) : null}
            {(latest.status === "completed" || latest.status === "failed" || latest.status === "canceled") ? (
              <button type="button" className="secondary-button" onClick={() => onRetry(latest.id)} disabled={busy}>Retry Wizard</button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CampaignPipelineStatus({
  campaignId,
  busy,
  onApprove,
  onCancel,
  onRetry,
  onAbandon,
}: {
  campaignId: string;
  busy: boolean;
  onApprove: (runId: string, startSession?: boolean) => void;
  onCancel: (runId: string) => void;
  onRetry: (runId: string, fromStep?: "fromLorebookRefresh" | "fromSysprompt") => void;
  onAbandon: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const runs = useQuery({
    queryKey: ["pipeline-runs", campaignId],
    queryFn: () => getPipelineRuns(campaignId),
    refetchInterval: (query) => {
      const status = query.state.data?.runs[0]?.status;
      return status === "queued" || status === "running" ? 2_000 : false;
    },
  });
  const latest = runs.data?.runs[0] ?? null;

  return (
    <div className="stack stack-tight">
      <p className="muted small-copy">Pipeline</p>
      {runs.isLoading ? <p className="muted small-copy">Loading pipeline runs...</p> : null}
      {runs.isError ? <p className="error">pipeline request failed</p> : null}
      {!runs.isLoading && !latest ? <p className="muted small-copy">No pipeline runs yet.</p> : null}
      {latest ? (
        <>
          <div className={`pipeline-actions-bar${latest.status === "completed" && !latest.approvedAt ? " is-ready" : ""}`}>
            {latest.status === "completed" && !latest.approvedAt ? <strong>Ready to approve</strong> : null}
            <span className="muted small-copy">{formatPipelineStatus(latest.status)}</span>
            <button type="button" className="secondary-button" onClick={() => setOpen((value) => !value)}>
              {open ? "Hide Review" : "Show Review"}
            </button>
            {(latest.status === "queued" || latest.status === "running") ? (
              <button type="button" className="danger-button" onClick={() => onCancel(latest.id)} disabled={busy}>Cancel Run</button>
            ) : null}
            {latest.status === "completed" && !latest.approvedAt ? (
              <>
                <button type="button" onClick={() => onApprove(latest.id, false)} disabled={busy}>Approve Draft</button>
                <button type="button" className="secondary-button" onClick={() => onApprove(latest.id, true)} disabled={busy}>Approve + Start Session</button>
              </>
            ) : null}
            {(latest.status === "completed" || latest.status === "failed") && !latest.approvedAt ? (
              <PipelineRetryButtons run={latest} busy={busy} onRetry={onRetry} />
            ) : null}
            {!latest.approvedAt && latest.status !== "queued" && latest.status !== "running" ? (
              <button type="button" className="danger-button" onClick={() => onAbandon(latest.id)} disabled={busy}>Abandon Run</button>
            ) : null}
          </div>
          <div className="placeholder-card stack stack-tight">
            <p className="muted small-copy">Requested {new Date(latest.requestedAt).toLocaleString()}</p>
            {latest.approvedAt ? <p className="muted small-copy">Approved {new Date(latest.approvedAt).toLocaleString()}</p> : null}
            <p className="message-body">{latest.summary || "Pipeline worker is preparing this run."}</p>
            {latest.error ? <p className="error">{latest.error}</p> : null}
          </div>
          {open ? <PipelineReviewDetails run={latest} /> : null}
        </>
      ) : null}
    </div>
  );
}

function PipelineRetryButtons({ run, busy, onRetry }: {
  run: PipelineRun;
  busy: boolean;
  onRetry: (runId: string, fromStep?: "fromLorebookRefresh" | "fromSysprompt") => void;
}) {
  return (
    <>
      {run.review.analysisReport ? (
        <button type="button" className="secondary-button" onClick={() => onRetry(run.id, "fromLorebookRefresh")} disabled={busy}>Retry from Lorebook</button>
      ) : null}
      {run.review.lorebookOperations ? (
        <button type="button" className="secondary-button" onClick={() => onRetry(run.id, "fromSysprompt")} disabled={busy}>Retry from Sysprompt</button>
      ) : null}
      <button type="button" className="secondary-button" onClick={() => onRetry(run.id)} disabled={busy}>Retry Full Run</button>
    </>
  );
}

function PipelineModelPicker({ availableModels, defaultModelId, busy, onRun }: {
  availableModels: { id: string; label: string }[];
  defaultModelId: string;
  busy: boolean;
  onRun: (creativeModelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creativeModelId, setCreativeModelId] = useState(defaultModelId);

  useEffect(() => {
    setCreativeModelId(defaultModelId);
  }, [defaultModelId]);

  useEffect(() => {
    if (availableModels.length && !availableModels.some((m) => m.id === creativeModelId)) setCreativeModelId(availableModels[0]!.id);
  }, [availableModels, creativeModelId]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={busy || !availableModels.length} style={{ borderColor: "var(--accent)", color: "var(--accent)", marginBottom: 8 }}>
        Run Pipeline
      </button>
      {open ? createPortal(
        <div className="dialog-backdrop" role="presentation" onClick={() => setOpen(false)} style={{ zIndex: 200 }}>
          <div className="dialog-card" role="dialog" aria-modal="true" aria-label="Run Pipeline" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420, padding: 20 }}>
            <h3 style={{ margin: "0 0 12px" }}>Run Pipeline</h3>
            <p className="muted small-copy" style={{ marginBottom: 16 }}>Select the model for the pipeline run. It handles analysis, lorebook refresh, and system prompt updates.</p>
            <div className="stack stack-tight">
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <label style={{ fontSize: 11, color: "var(--text2)", whiteSpace: "nowrap", minWidth: 80 }}>Model:</label>
                <select value={creativeModelId} onChange={(e) => setCreativeModelId(e.target.value)} style={{ fontSize: 11, flex: 1 }}>
                  {availableModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" className="ghost-button" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" onClick={() => { onRun(creativeModelId); setOpen(false); }} disabled={busy} style={{ background: "var(--accent)", color: "#fff", border: "none" }}>
                Run Pipeline
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function CampaignVersionHistory({
  campaignId,
  busy,
  onRestore,
}: {
  campaignId: string;
  busy: boolean;
  onRestore: (version: number) => void;
}) {
  const [previewVersion, setPreviewVersion] = useState<{ version: number; field: string; content: string } | null>(null);
  const versions = useQuery({
    queryKey: ["campaign-versions", campaignId],
    queryFn: () => getCampaignVersions(campaignId),
  });

  if (versions.isLoading) return <p className="muted small-copy" style={{ padding: 12 }}>Loading history...</p>;
  if (versions.isError) return <p className="error" style={{ padding: 12 }}>Campaign history request failed</p>;
  if (!(versions.data?.versions.length)) return <div style={{ fontSize: 11, color: "var(--text2)", padding: 12 }}>No version history yet. Versions are archived when you approve a pipeline update.</div>;

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
      {versions.data.versions.map((version) => {
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
            {!version.isCurrent && !isSnapshot ? <button type="button" className="secondary-button" style={{ fontSize: 10, padding: "2px 6px", color: "var(--amber)", borderColor: "var(--amber)" }} onClick={() => onRestore(version.version)} disabled={busy}>Restore</button> : null}
          </div>
        );
      })}
    </div>
  );
}

function CampaignContextDefaults({
  defaults,
  availableModels,
  busy,
  onChange,
}: {
  defaults: Record<string, unknown>;
  availableModels: { id: string; label: string }[];
  busy: boolean;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const resolved = {
    mode: "keyword" as string,
    embeddingModel: "openai:text-embedding-3-large" as string,
    retrievalBudgetTokens: 4000,
    scanDepth: 4,
    researcherEnabled: true,
    researcherModel: "claude-sonnet-4-6",
    rollingEnabled: true,
    rollingCadence: 4,
    rollingModel: "claude-haiku-4-5",
    ...defaults,
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: 12 }}>
      <p className="muted small-copy" style={{ marginBottom: 12 }}>Default context engine settings for all sessions in this campaign. Sessions can override these individually.</p>

      <div className="stack stack-tight">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "var(--text2)", minWidth: 100 }}>Context Mode:</label>
          <select value={resolved.mode} onChange={(e) => onChange({ mode: e.target.value })} disabled={busy} style={{ fontSize: 11, flex: 1 }}>
            <option value="keyword">Keyword</option>
            <option value="semantic">Semantic</option>
            <option value="hybrid">Hybrid</option>
            <option value="off">Off</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "var(--text2)", minWidth: 100 }}>Embedding:</label>
          <select value={resolved.embeddingModel} onChange={(e) => onChange({ embeddingModel: e.target.value })} disabled={busy} style={{ fontSize: 11, flex: 1 }}>
            {EMBEDDING_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <p className="muted small-copy" style={{ margin: 0, fontSize: 10 }}>Changing the embedding model requires re-embedding this campaign's entries before semantic retrieval matches again.</p>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "var(--text2)", minWidth: 100 }}>Researcher:</label>
          <button
            type="button"
            className={`toggle-pill ${resolved.researcherEnabled ? "active" : ""}`}
            onClick={() => onChange({ researcherEnabled: !resolved.researcherEnabled })}
            disabled={busy}
            style={{ fontSize: 10, padding: "1px 8px" }}
          >
            {resolved.researcherEnabled ? "On" : "Off"}
          </button>
          {resolved.researcherEnabled ? (
            <select value={resolved.researcherModel} onChange={(e) => onChange({ researcherModel: e.target.value })} disabled={busy} style={{ fontSize: 11, flex: 1 }}>
              {availableModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "var(--text2)", minWidth: 100 }}>Rolling Diff:</label>
          <button
            type="button"
            className={`toggle-pill ${resolved.rollingEnabled ? "active" : ""}`}
            onClick={() => onChange({ rollingEnabled: !resolved.rollingEnabled })}
            disabled={busy}
            style={{ fontSize: 10, padding: "1px 8px" }}
          >
            {resolved.rollingEnabled ? "On" : "Off"}
          </button>
          {resolved.rollingEnabled ? (
            <>
              <span style={{ fontSize: 10, color: "var(--text2)" }}>every</span>
              <NumericInput min={1} max={32} value={resolved.rollingCadence} onChange={(v) => onChange({ rollingCadence: v })} disabled={busy} style={{ width: 40, fontSize: 11 }} />
              <span style={{ fontSize: 10, color: "var(--text2)" }}>turns</span>
              <select value={resolved.rollingModel} onChange={(e) => onChange({ rollingModel: e.target.value })} disabled={busy} style={{ fontSize: 11, flex: 1 }}>
                {availableModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "var(--text2)", minWidth: 100 }}>Budget:</label>
          <NumericInput min={0} max={50000} step={500} value={resolved.retrievalBudgetTokens} onChange={(v) => onChange({ retrievalBudgetTokens: v })} disabled={busy} style={{ width: 70, fontSize: 11 }} />
          <span style={{ fontSize: 10, color: "var(--text2)" }}>tokens</span>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "var(--text2)", minWidth: 100 }}>Scan Depth:</label>
          <NumericInput min={0} max={100} value={resolved.scanDepth} onChange={(v) => onChange({ scanDepth: v })} disabled={busy} style={{ width: 50, fontSize: 11 }} />
          <span style={{ fontSize: 10, color: "var(--text2)" }}>turns</span>
        </div>
      </div>
    </div>
  );
}

function formatPipelineStatus(status: PipelineRunStatus) {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "canceled") return "Canceled";
  return "Failed";
}

function formatWizardStatus(status: WizardRunStatus) {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  return "Failed";
}

