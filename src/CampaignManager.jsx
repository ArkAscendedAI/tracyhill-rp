import { useState, useEffect } from "react";
import { X, Plus, ChevronRight, ChevronDown, Edit3, Trash2, BookOpen } from "lucide-react";

export default function CampaignManager({ open, onClose, campaigns, onRefresh, folders, onStartSession, showConfirm, customEndpoints }) {
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null); // campaign object being edited
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState("seed"); // seed | system | updatePrompt | sysUpdatePrompt | history
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [versions, setVersions] = useState([]);
  const [versionPreview, setVersionPreview] = useState(null); // { filename, content }

  // New campaign form
  const [newName, setNewName] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [newVersion, setNewVersion] = useState(0);

  useEffect(() => { if (open) { setSelected(null); setEditing(null); setCreating(false); setError(""); } }, [open]);

  if (!open) return null;

  async function handleCreate() {
    if (!newName.trim()) return;
    setError("");
    try {
      const r = await fetch("/api/campaigns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newName.trim(), folderId: newFolder || null, stateSeedVersion: newVersion || 0 }) });
      if (!r.ok) { const d = await r.json(); setError(d.error || "Create failed"); return; }
      setCreating(false); setNewName(""); setNewFolder(""); setNewVersion(0);
      onRefresh();
    } catch (e) { setError(e.message); }
  }

  async function loadVersions(id) {
    try { const r = await fetch(`/api/campaigns/${id}/versions`); if (r.ok) setVersions(await r.json()); else setVersions([]); } catch { setVersions([]); }
  }
  async function previewVersion(campaignId, filename) {
    try { const r = await fetch(`/api/campaigns/${campaignId}/versions/${filename}`); if (r.ok) setVersionPreview({ filename, content: await r.text() }); } catch {}
  }
  async function restoreVersion(campaignId, version) {
    setError("");
    try {
      const r = await fetch(`/api/campaigns/${campaignId}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version }) });
      if (!r.ok) { const d = await r.json(); setError(d.error || "Restore failed"); return; }
      loadFull(campaignId); loadVersions(campaignId); onRefresh();
    } catch (e) { setError(e.message); }
  }

  async function loadFull(id) {
    try {
      const r = await fetch(`/api/campaigns/${id}`);
      if (!r.ok) return;
      const c = await r.json();
      setEditing(c); setVersionPreview(null);
      setTab("seed");
    } catch {}
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true); setError("");
    try {
      const r = await fetch(`/api/campaigns/${editing.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editing) });
      if (!r.ok) { const d = await r.json(); setError(d.error || "Save failed"); setSaving(false); return; }
      setSaving(false);
      onRefresh();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  async function handleDelete(id) {
    try {
      await fetch(`/api/campaigns/${id}`, { method: "DELETE" });
      setEditing(null); setSelected(null);
      onRefresh();
    } catch {}
  }

  function updateField(field, value) {
    setEditing(prev => ({ ...prev, [field]: value }));
  }

  const tabLabels = { seed: "State Seed", system: "System Prompt", updatePrompt: "Seed Update Prompt", sysUpdatePrompt: "Sys Prompt Update Prompt", history: `History (${versions.length})` };
  const tabFields = { seed: "stateSeed", system: "systemPrompt", updatePrompt: "updatePromptTemplate", sysUpdatePrompt: "systemPromptUpdateTemplate" };

  return (<div className="modal-overlay" onClick={onClose}><div className="modal campaign-modal" onClick={e => e.stopPropagation()}>
    <div className="modal-header">
      <h3><BookOpen size={16} /> Campaign Manager</h3>
      <button className="icon-btn" onClick={onClose}><X size={18} /></button>
    </div>

    <div className="campaign-layout">
      {/* Left: campaign list */}
      <div className="campaign-list">
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <button className="btn-sm accent" onClick={() => setCreating(true)}><Plus size={12} /> New</button>
        </div>

        {creating && <div className="campaign-create-form">
          <input placeholder="Campaign name" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && handleCreate()} />
          <select value={newFolder} onChange={e => setNewFolder(e.target.value)}>
            <option value="">No folder (archive)</option>
            {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <label style={{ fontSize: 10, color: "var(--text2)", whiteSpace: "nowrap" }}>Current version:</label>
            <input type="number" min={0} value={newVersion} onChange={e => setNewVersion(Math.max(0, parseInt(e.target.value) || 0))} style={{ width: 50, fontSize: 11, padding: "2px 4px", background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 4 }} />
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="btn-sm accent" onClick={handleCreate}>Create</button>
            <button className="btn-sm" onClick={() => { setCreating(false); setNewName(""); setNewVersion(0); }}>Cancel</button>
          </div>
        </div>}

        {campaigns.map(c => (
          <div key={c.id} className={`campaign-item ${selected === c.id ? "active" : ""}`} onClick={() => { setSelected(c.id); loadFull(c.id); loadVersions(c.id); }}>
            <div className="campaign-item-name">{c.name}</div>
            <div className="campaign-item-meta">v{c.stateSeedVersion || 0} · {c.hasStateSeed ? "✓" : "—"} seed · {c.hasSystemPrompt ? "✓" : "—"} prompt</div>
          </div>
        ))}
        {campaigns.length === 0 && !creating && <div style={{ fontSize: 11, color: "var(--text2)", padding: 8 }}>No campaigns yet. Click + New to create one.</div>}
      </div>

      {/* Right: campaign editor */}
      <div className="campaign-editor">
        {!editing ? <div className="campaign-empty">Select a campaign to edit</div> : <>
          <div className="campaign-editor-header">
            <input className="campaign-name-input" value={editing.name} onChange={e => updateField("name", e.target.value)} />
            <select value={editing.folderId || ""} onChange={e => updateField("folderId", e.target.value || null)} style={{ fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 4, padding: "2px 4px" }}>
              <option value="">No folder</option>
              {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <select value={editing.pipelineModel || "claude-opus-4-6"} onChange={e => updateField("pipelineModel", e.target.value)} style={{ fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 4, padding: "2px 4px" }}>
              <optgroup label="Anthropic">
                <option value="claude-opus-4-6">Opus 4.6</option>
                <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                <option value="claude-sonnet-4">Sonnet 4</option>
                <option value="claude-haiku-4.5">Haiku 4.5</option>
              </optgroup>
              <optgroup label="OpenAI">
                <option value="gpt-5.4">GPT-5.4</option>
              </optgroup>
              <optgroup label="xAI">
                <option value="grok-4">Grok 4</option>
              </optgroup>
              <optgroup label="Google">
                <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro</option>
              </optgroup>
              <optgroup label="z.ai">
                <option value="glm-5">GLM-5</option>
              </optgroup>
              {(customEndpoints || []).filter(ep => ep.models?.length && (ep.hasKey || ep.authHeader === "none")).map(ep => <optgroup key={ep.id} label={`${ep.name} (Beta)`}>{ep.models.map(m => <option key={m.id} value={`custom:${ep.id}:${m.id}`}>{m.label || m.id}</option>)}</optgroup>)}
            </select>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}><label style={{ fontSize: 10, color: "var(--text2)" }}>v</label><input type="number" min={0} value={editing.stateSeedVersion || 0} onChange={e => updateField("stateSeedVersion", Math.max(0, parseInt(e.target.value) || 0))} style={{ width: 45, fontSize: 11, padding: "2px 4px", background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 4 }} /></div>
          </div>
          {editing.pipelineModel?.startsWith("custom:") && <div style={{ background: "rgba(255,180,0,0.12)", border: "1px solid var(--amber)", borderRadius: 4, padding: "6px 10px", margin: "4px 0", fontSize: 11, color: "var(--amber)" }}>Beta: Custom endpoint pipelines are experimental. Prompts are optimized for flagship providers — results may vary with third-party models.</div>}

          <div className="campaign-tabs">
            {Object.entries(tabLabels).map(([k, label]) => (
              <button key={k} className={`campaign-tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>

          {tab !== "history" ? <textarea className="campaign-textarea" value={editing[tabFields[tab]] || ""} onChange={e => updateField(tabFields[tab], e.target.value)} placeholder={`Paste ${tabLabels[tab]} content here...`} /> : <div className="campaign-textarea" style={{ overflow: "auto", padding: 10 }}>
            {versions.length === 0 && <div style={{ fontSize: 11, color: "var(--text2)" }}>No version history yet. Versions are archived automatically when you approve a pipeline update.</div>}
            {versionPreview ? <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{versionPreview.filename}</span>
                <button className="btn-sm" onClick={() => setVersionPreview(null)}>← Back</button>
              </div>
              <pre style={{ fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", color: "var(--text)", margin: 0 }}>{versionPreview.content}</pre>
            </div> : versions.slice().reverse().map((v, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)", minWidth: 30 }}>v{v.version}</span>
              <span style={{ fontSize: 10, color: "var(--text2)", flex: 1 }}>{new Date(v.timestamp).toLocaleString()}</span>
              {v.hasSeed && <button className="btn-sm" style={{ fontSize: 10 }} onClick={() => previewVersion(editing.id, `seed_v${v.version}.md`)}>View Seed</button>}
              {v.hasSystemPrompt && <button className="btn-sm" style={{ fontSize: 10 }} onClick={() => previewVersion(editing.id, `system_prompt_v${v.version}.md`)}>View Prompt</button>}
              <button className="btn-sm" style={{ fontSize: 10, color: "var(--amber)", borderColor: "var(--amber)" }} onClick={() => restoreVersion(editing.id, v.version)}>Restore</button>
            </div>)}
          </div>}

          <div className="campaign-actions">
            <button className="btn-sm accent" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
            <button className="btn-sm green" onClick={() => onStartSession(editing)}>Start New Session</button>
            <button className="btn-sm red" onClick={() => showConfirm ? showConfirm(`Delete campaign "${editing.name}"? This removes the campaign record but not the folder or sessions.`, () => handleDelete(editing.id)) : handleDelete(editing.id)}>Delete Campaign</button>
            {error && <span style={{ fontSize: 11, color: "var(--red)" }}>{error}</span>}
          </div>
        </>}
      </div>
    </div>
  </div></div>);
}
