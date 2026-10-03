import type { ProviderKeyListResponse } from "@tracyhill-rp/contracts";

import { getSavedChatModel } from "../auth/providerKeyApi";

// The Engine panel's model dials are controlled <select>s fed only by the
// key-filtered picker list (`buildAvailableChatModels`). A saved id whose
// provider key was removed — or a deployment DEFAULT_MODEL_ID the account has
// no key for — is absent from that list, and a controlled <select> whose value
// matches no <option> renders the browser default (the FIRST option), so the
// popover displayed a model the server does not run while the chip next to it
// (catalog-labelled) showed the real one. This is
// the treatment the main model picker received on 2026-09-05, for the
// dials: a disabled option carrying the saved id, so the select shows what the
// server resolves and the note says why it cannot be re-picked.
export type SavedModelOption = { id: string; label: string; note: string | null };

export function describeSavedModelOption(
  models: ReadonlyArray<{ id: string; label: string }>,
  value: string,
  config: ProviderKeyListResponse | null | undefined,
): SavedModelOption | null {
  if (!value || models.some((model) => model.id === value)) return null;
  const saved = getSavedChatModel(value, config);
  // Before the provider-keys bootstrap resolves the list is the full catalog,
  // so an absent id (a custom-endpoint model) has no verdict yet — show it
  // without a note rather than a false "configure its key".
  if (!config) return { id: value, label: saved?.label ?? value, note: null };
  return saved
    ? { id: value, label: saved.label, note: "unavailable — configure its provider key" }
    : { id: value, label: value, note: "unknown model — not in this build's catalog" };
}

export function ModelDialOptions({ models, value, config }: {
  models: ReadonlyArray<{ id: string; label: string }>;
  value: string;
  config: ProviderKeyListResponse | null | undefined;
}) {
  const saved = describeSavedModelOption(models, value, config);
  return (
    <>
      {saved ? <option value={saved.id} disabled>{saved.label}{saved.note ? ` (${saved.note})` : ""}</option> : null}
      {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
    </>
  );
}
