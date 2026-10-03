import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { importWizardRunRequestSchema } from "@tracyhill-rp/contracts";

import { buildAvailableChatModels, getProviderKeys } from "../auth/providerKeyApi";
import { stringMaxLength } from "../lorebook/contractBounds";
import { AutoTextarea } from "../../shared/ui/AutoTextarea";
import { Dialog } from "../../shared/ui/Dialog";
import { importWizardRun } from "./wizardApi";
import { campaignNameFromFile, estimateImportCalls, summarizeLorebookFile, type LorebookFileSummary } from "./lorebookFile";

// Import a SillyTavern lorebook as a new campaign. The wizard converts it in the
// background and the owner reviews the result in the wizard review before anything is created.

const FIELDS = importWizardRunRequestSchema.shape;
const NAME_MAX = stringMaxLength(FIELDS.campaignName);
const PC_MAX = stringMaxLength(FIELDS.playerCharacterName);
const NOTES_MAX = stringMaxLength(FIELDS.notes);

type ChosenFile = { name: string; json: unknown; summary: LorebookFileSummary };

type ImportLorebookDialogProps = {
  open: boolean;
  // A wizard run is queued or running: one at a time per account.
  wizardBusy: boolean;
  onClose: () => void;
  onImported: (runId: string) => void;
};

export function ImportLorebookDialog({ open, wizardBusy, onClose, onImported }: ImportLorebookDialogProps) {
  const [file, setFile] = useState<ChosenFile | null>(null);
  const [fileError, setFileError] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [playerCharacterName, setPlayerCharacterName] = useState("");
  const [charName, setCharName] = useState("");
  const [notes, setNotes] = useState("");
  const [modelIdRaw, setModelId] = useState<string | null>(null);
  const [addCharacterSections, setAddCharacterSections] = useState(true);
  const providerConfig = useQuery({ queryKey: ["provider-keys"], queryFn: getProviderKeys, enabled: open });
  const models = buildAvailableChatModels(providerConfig.data);
  // The owner's pick, else the deployment's default model, else the first model with a key (the wizard's rule).
  const modelId = modelIdRaw ?? providerConfig.data?.defaultModelOverride ?? models[0]?.id ?? "";
  const mutation = useMutation({
    mutationFn: importWizardRun,
    onSuccess: (response) => onImported(response.runId),
  });

  if (!open) return null;

  const chooseFile = (chosen: File | undefined) => {
    setFileError("");
    setFile(null);
    mutation.reset();
    if (!chosen) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        setFileError("This file is not JSON. Choose a SillyTavern World Info file (.json) or a character card saved as JSON.");
        return;
      }
      const summary = summarizeLorebookFile(json, text);
      if (!summary || summary.entries === 0) {
        setFileError("This file has no lorebook entries. Choose a SillyTavern World Info file or a character card with a lorebook.");
        return;
      }
      setFile({ name: chosen.name, json, summary });
    };
    reader.onerror = () => setFileError("The file could not be read.");
    reader.readAsText(chosen);
  };

  const suggestedName = file ? file.summary.bookName ?? campaignNameFromFile(file.name) : "";
  const missing = !file ? "Choose a lorebook file." : !campaignName.trim() ? "Name the campaign." : !playerCharacterName.trim() ? "Name the character you will play." : !modelId ? "No chat model is available. Add a provider key first." : null;
  const busy = mutation.isPending;
  const submit = () => {
    if (missing || busy || wizardBusy || !file) return;
    mutation.mutate({
      format: "sillytavern",
      fileName: file.name,
      campaignName: campaignName.trim(),
      playerCharacterName: playerCharacterName.trim(),
      charName: charName.trim(),
      notes: notes.trim(),
      modelId,
      addCharacterSections,
      lorebook: file.json,
    });
  };

  return (
    <Dialog open onClose={onClose} label="Import SillyTavern lorebook" eyebrow="New campaign" title="Import a SillyTavern Lorebook" icon="book" size="lg" className="import-lorebook-dialog" closeDisabled={busy}>
      <div className="stack">
        <p className="muted small-copy">
          The wizard turns the lorebook into a campaign: it keeps every entry's text and trigger settings, sorts the entries into characters, places, factions and lore, gives each character what the campaign needs to run them, and writes the system prompt. You review the result before anything is created.
        </p>

        <label className="stack stack-tight">
          <span>Lorebook file</span>
          <input type="file" aria-label="Lorebook file" accept=".json,application/json" disabled={busy} onChange={(event) => chooseFile(event.target.files?.[0])} />
          {file ? (
            <span className="muted small-copy">
              {file.name}: {file.summary.entries} {file.summary.entries === 1 ? "entry" : "entries"}. Converting it makes roughly {estimateImportCalls(file.summary.entries)} model calls on the model below.
            </span>
          ) : null}
          {fileError ? <span className="error small-copy" role="alert">{fileError}</span> : null}
        </label>

        <label className="stack stack-tight">
          <span>Campaign name</span>
          <input aria-label="Campaign name" maxLength={NAME_MAX} placeholder={suggestedName ? `For example, ${suggestedName}` : "Name the new campaign"} value={campaignName} disabled={busy} onChange={(event) => setCampaignName(event.target.value)} />
        </label>

        <label className="stack stack-tight">
          <span>Your character</span>
          <input aria-label="Your character" list="import-lorebook-titles" maxLength={PC_MAX} placeholder="The name of the character you will play" value={playerCharacterName} disabled={busy} onChange={(event) => setPlayerCharacterName(event.target.value)} />
          <span className="muted small-copy">Every {"{{user}}"} in the lorebook becomes this name. Pick an entry's name if the lorebook describes your character.</span>
        </label>

        {file?.summary.usesChar ? (
          <label className="stack stack-tight">
            <span>Who is {"{{char}}"}?</span>
            <input aria-label="Who is char" list="import-lorebook-titles" maxLength={PC_MAX} placeholder="Leave blank to fill it in entry by entry" value={charName} disabled={busy} onChange={(event) => setCharName(event.target.value)} />
            <span className="muted small-copy">This lorebook uses {"{{char}}"}, SillyTavern's name for the character card's character. Left blank, each entry's {"{{char}}"} becomes the character that entry is about, which is how most lorebooks use it. Give a name only if every {"{{char}}"} in this book means the same person.</span>
          </label>
        ) : null}
        <datalist id="import-lorebook-titles">{(file?.summary.titles ?? []).map((title) => <option key={title} value={title} />)}</datalist>

        <label className="stack stack-tight">
          <span>Notes for the wizard (optional)</span>
          <AutoTextarea aria-label="Notes for the wizard" minRows={3} maxRows={10} maxLength={NOTES_MAX} placeholder="What the lorebook does not say: the tone and content rating you want, how long replies should be, and who your character is." value={notes} disabled={busy} onChange={(event) => setNotes(event.target.value)} />
        </label>

        <label className="stack stack-tight">
          <span>Model</span>
          <select aria-label="Import model" value={modelId} disabled={busy || models.length === 0} onChange={(event) => setModelId(event.target.value)}>
            {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </label>

        <label className="row gap-sm align-left">
          <input type="checkbox" aria-label="Add native character sections" checked={addCharacterSections} disabled={busy} onChange={(event) => setAddCharacterSections(event.target.checked)} />
          <span className="small-copy">Add what a character entry here has and the lorebook's may lack: a physical description, how they talk, a few lines in their voice, and how they see your character. The lorebook's own text is always kept.</span>
        </label>

        {wizardBusy ? <p className="muted small-copy">A wizard run is already in progress. Wait for it to finish, or cancel it, before importing.</p> : null}
        {mutation.error ? <p className="error" role="alert">{mutation.error.message}</p> : null}
        <div className="row gap-sm end wrap-row">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" disabled={Boolean(missing) || busy || wizardBusy} title={missing ?? undefined} onClick={submit}>
            {busy ? "Sending..." : "Import and Build Campaign"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
