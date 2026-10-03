import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createUserScopedCacheWriter } from "./authCache";

import { NumericInput } from "../../shared/ui/NumericInput";

import {
  isServerManagedProvider,
  type CustomEndpointApiFormat,
  type CustomEndpointAuthHeader,
  type CustomEndpointInput,
  type ProviderId,
  type ProviderKeyStatus,
  type ProviderKeyStatusMap,
  type UpdateProviderKeysRequest,
} from "@tracyhill-rp/contracts";

import { CUSTOM_ENDPOINT_TEXT_MAX, customEndpointDraftsProblem } from "./customEndpointDrafts";
import { getProviderKeys, updateProviderKeys } from "./providerKeyApi";
import { API_KEY_PROVIDERS } from "./providerList";
import { SubscriptionCards } from "./SubscriptionCards";
import { Dialog } from "../../shared/ui/Dialog";

type ProviderKeysDialogProps = {
  open: boolean;
  onClose: () => void;
};

type CustomEndpointDraft = {
  id: string;
  name: string;
  baseUrl: string;
  apiFormat: CustomEndpointApiFormat;
  authHeader: CustomEndpointAuthHeader;
  hasKey: boolean;
  // Server flag: a stored key exists but no longer decrypts.
  keyNeedsReentry: boolean;
  apiKeyInput: string;
  apiKeyMode: "keep" | "replace" | "clear";
  models: Array<{ id: string; label: string; maxOut: number; ctx: number }>;
};

const PROVIDERS = API_KEY_PROVIDERS;

export function ProviderKeysDialog({ open, onClose }: ProviderKeysDialogProps) {
  const queryClient = useQueryClient();
  const cacheUserQuery = createUserScopedCacheWriter(queryClient);
  const [drafts, setDrafts] = useState(createEmptyDrafts);
  const [touched, setTouched] = useState(createEmptyTouched);
  // Distinguish an EXPLICIT "Clear Override" from an accidentally
  // typed-then-erased (empty) field. Only an explicit clear sends provider: null
  // (a deletion); an empty field that was merely touched is a no-op so a stray
  // keystroke can't silently wipe the stored key.
  const [cleared, setCleared] = useState(createEmptyTouched);
  const [endpointDrafts, setEndpointDrafts] = useState<CustomEndpointDraft[]>([]);
  const [endpointsTouched, setEndpointsTouched] = useState(false);
  const [localError, setLocalError] = useState("");
  const query = useQuery({
    queryKey: ["provider-keys"],
    queryFn: getProviderKeys,
    enabled: open,
  });
  const mutation = useMutation({
    mutationFn: updateProviderKeys,
    onSuccess: (data) => {
      cacheUserQuery(["provider-keys"], data);
      setDrafts(createEmptyDrafts());
      setTouched(createEmptyTouched());
      setCleared(createEmptyTouched());
      setEndpointDrafts(data.customEndpoints.map(createEndpointDraft));
      setEndpointsTouched(false);
      setLocalError("");
    },
  });

  useEffect(() => {
    if (!open) {
      setDrafts(createEmptyDrafts());
      setTouched(createEmptyTouched());
      setCleared(createEmptyTouched());
      setEndpointDrafts([]);
      setEndpointsTouched(false);
      setLocalError("");
      return;
    }
    if (!query.data) return;
    // Never clobber in-progress edits: a window-focus refetch used to rebuild
    // the drafts from the server mid-edit, silently discarding all endpoint
    // changes. Only seed when the user hasn't touched them.
    setEndpointDrafts((current) => (endpointsTouched ? current : query.data.customEndpoints.map(createEndpointDraft)));
  }, [open, query.data, endpointsTouched]);

  if (!open) return null;

  const busy = query.isLoading || mutation.isPending;
  const changedProviders = PROVIDERS.filter(({ id }) => touched[id]);
  // The inputs used to render only under query.data, so when the key
  // list failed to load (e.g. every stored key undecryptable after a
  // SESSION_SECRET rotation, before the server learned to report needsReentry)
  // the user saw an error and no way to re-enter anything. Fall back to an
  // "unknown" status map so keys can always be (re-)pasted.
  const statusUnknown = !query.data && !query.isLoading;
  const providerStatuses: ProviderKeyStatusMap = query.data?.providers ?? createUnknownStatusMap();

  const submit = () => {
    setLocalError("");
    if (!changedProviders.length && !endpointsTouched) {
      setLocalError("No provider or custom-endpoint changes to save");
      return;
    }
    const payload: UpdateProviderKeysRequest = {};
    for (const { id } of changedProviders) {
      if (isServerManagedProvider(id)) continue; // bridge providers are server-configured; never part of a save
      const value = drafts[id].trim();
      if (value) {
        payload[id] = value;
      } else if (cleared[id]) {
        // Explicit "Clear Override" → delete the stored key.
        payload[id] = null;
      }
      // Empty + not explicitly cleared (typed then erased): skip — do NOT delete.
    }
    if (!Object.keys(payload).length && !endpointsTouched) {
      setLocalError("No provider or custom-endpoint changes to save");
      return;
    }
    if (endpointsTouched) {
      const problem = customEndpointDraftsProblem(endpointDrafts);
      if (problem) {
        setLocalError(problem);
        return;
      }
      payload.customEndpoints = endpointDrafts
        .map<CustomEndpointInput>((endpoint) => ({
          id: endpoint.id,
          name: endpoint.name,
          baseUrl: endpoint.baseUrl,
          apiKey: endpoint.apiKeyMode === "keep" ? undefined : endpoint.apiKeyMode === "clear" ? "" : endpoint.apiKeyInput,
          apiFormat: endpoint.apiFormat,
          authHeader: endpoint.authHeader,
          models: endpoint.models.filter((model) => model.id.trim()).map((model) => ({
            id: model.id.trim(),
            label: model.label.trim(),
            maxOut: clampNumber(model.maxOut, 1, 2_097_152, 4096),
            ctx: clampNumber(model.ctx, 1, 10_000_000, 128000),
          })),
        }))
        .filter((endpoint) => endpoint.name.trim() && endpoint.baseUrl.trim());
    }
    mutation.mutate(payload);
  };

  return (
    <Dialog open onClose={onClose} label="Providers" eyebrow="Account" title="Providers" icon="key" size="xl" className="provider-keys-dialog" closeDisabled={busy}>
        <div className="stack stack-tight">
          <div className="section-head">
            <div>
              <p className="eyebrow">API keys</p>
              <h3>Pay-as-you-go providers</h3>
            </div>
          </div>
          <p className="muted small-copy">A key stored here is used for this account instead of the server's shared key, where the server has one. Replacing a key updates chat, image generation, pipeline, and wizard runtime selection.</p>
          {query.isLoading ? <p className="muted small-copy">Loading provider key status…</p> : null}
          {query.error ? <p className="error">{query.error.message}</p> : null}
          {statusUnknown ? (
            <p className="muted small-copy">
              Stored key status could not be loaded. You can still paste a key below and save — this replaces whatever is stored for that provider (the usual repair after a server secret rotation).
            </p>
          ) : null}
          {!query.isLoading ? (
            <div className="stack stack-tight">
              {PROVIDERS.map(({ id, label, detail }) => {
                const status = providerStatuses[id];
                return (
                  <div key={id} className="stack stack-tight">
                    <div>
                      <div className="section-head">
                        <strong>{label}</strong>
                        <span className="muted small-copy">{formatStatus(status)}</span>
                      </div>
                      <p className="muted small-copy">{detail}</p>
                    </div>
                    <div className="row gap-sm wrap-row">
                      <input
                        aria-label={`${label} API key`}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={status.needsReentry ? "Re-enter API key" : status.source === "user" && status.keyPreview ? `Replace stored key ${status.keyPreview}` : "Paste API key"}
                        value={drafts[id]}
                        onChange={(event) => {
                          setDrafts((current) => ({ ...current, [id]: event.target.value }));
                          setTouched((current) => ({ ...current, [id]: true }));
                          // Typing/erasing is not an explicit clear — drop any prior
                          // clear intent so an emptied field is treated as a no-op.
                          setCleared((current) => current[id] ? { ...current, [id]: false } : current);
                        }}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy || (!drafts[id].trim() && status.source !== "user")}
                        onClick={() => {
                          setDrafts((current) => ({ ...current, [id]: "" }));
                          setTouched((current) => ({ ...current, [id]: true }));
                          // Explicit clear: this is the ONLY path that sends provider: null.
                          setCleared((current) => ({ ...current, [id]: true }));
                        }}
                      >
                        Clear Override
                      </button>
                    </div>
                    {status.updatedAt ? <p className="muted small-copy">Last updated {new Date(status.updatedAt).toLocaleString()}</p> : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* Subscriptions stand apart from the key rows: their status query has its own
              loading and failure lines, so a runner outage never hides the API keys. The
              provider-keys response seeds the cards when it carries the block. */}
          <SubscriptionCards
            open={open}
            seed={query.data?.subscriptions ?? null}
            sharedServes={{ claude: providerStatuses["claude-code"].source === "server", chatgpt: providerStatuses["codex-bridge"].source === "server" }}
          />

          {query.data ? (
            <div className="stack stack-tight">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Custom Endpoints</p>
                  <h3>OpenAI-Compatible Providers</h3>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setEndpointDrafts((current) => [...current, createNewEndpointDraft()]);
                    setEndpointsTouched(true);
                  }}
                >
                  Add Endpoint
                </button>
              </div>
              <p className="muted small-copy">
                Add OpenAI-compatible endpoints like OpenRouter, LM Studio, Ollama, Together AI, Groq, or vLLM, then define the chat models you want surfaced in the picker.
                The base URL must start with https://, and plain http:// is refused. A server on your own network, such as LM Studio or Ollama, works only over https and only when the operator of this server allows its host name.
              </p>
              {!endpointDrafts.length ? <p className="muted small-copy">No custom endpoints configured yet.</p> : null}
              {endpointDrafts.map((endpoint, index) => (
                <div key={endpoint.id} className="placeholder-card stack stack-tight">
                  <div className="section-head">
                    <strong>{endpoint.name.trim() || "New Endpoint"}</strong>
                    <button
                      type="button"
                      className="danger-button"
                      disabled={busy}
                      onClick={() => {
                        setEndpointDrafts((current) => current.filter((_, currentIndex) => currentIndex !== index));
                        setEndpointsTouched(true);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                  <label className="stack stack-tight">
                    <span className="muted small-copy">Name</span>
                    <input
                      aria-label={`Custom endpoint name ${index + 1}`}
                      maxLength={CUSTOM_ENDPOINT_TEXT_MAX.name}
                      value={endpoint.name}
                      onChange={(event) => updateEndpoint(index, { name: event.target.value })}
                      disabled={busy}
                    />
                  </label>
                  <label className="stack stack-tight">
                    <span className="muted small-copy">Base URL</span>
                    <input
                      aria-label={`Custom endpoint base URL ${index + 1}`}
                      placeholder="https://api.example.com/v1"
                      value={endpoint.baseUrl}
                      onChange={(event) => updateEndpoint(index, { baseUrl: event.target.value })}
                      disabled={busy}
                    />
                  </label>
                  <label className="stack stack-tight">
                    <span className="muted small-copy">API Key</span>
                    <input
                      aria-label={`Custom endpoint API key ${index + 1}`}
                      type="password"
                      value={endpoint.apiKeyInput}
                      placeholder={endpoint.keyNeedsReentry ? "Stored key unreadable — re-enter" : endpoint.hasKey && endpoint.apiKeyMode !== "clear" ? "Stored key kept unless replaced" : "Leave blank for local/no-auth servers"}
                      onChange={(event) => updateEndpoint(index, {
                        apiKeyInput: event.target.value,
                        apiKeyMode: event.target.value ? "replace" : endpoint.hasKey ? "keep" : "replace",
                      })}
                      disabled={busy}
                    />
                  </label>
                  <div className="row gap-sm wrap-row">
                    <label className="stack stack-tight">
                      <span className="muted small-copy">API Format</span>
                      <select
                        aria-label={`Custom endpoint API format ${index + 1}`}
                        value={endpoint.apiFormat}
                        onChange={(event) => updateEndpoint(index, { apiFormat: event.target.value as CustomEndpointApiFormat })}
                        disabled={busy}
                      >
                        <option value="chat-completions">Chat Completions</option>
                        <option value="responses">Responses API</option>
                      </select>
                    </label>
                    <label className="stack stack-tight">
                      <span className="muted small-copy">Auth Header</span>
                      <select
                        aria-label={`Custom endpoint auth header ${index + 1}`}
                        value={endpoint.authHeader}
                        onChange={(event) => updateEndpoint(index, { authHeader: event.target.value as CustomEndpointAuthHeader })}
                        disabled={busy}
                      >
                        <option value="Bearer">Bearer</option>
                        <option value="api-key">api-key</option>
                        <option value="none">None</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || (!endpoint.hasKey && endpoint.apiKeyMode !== "replace")}
                      onClick={() => updateEndpoint(index, { apiKeyInput: "", apiKeyMode: "clear", hasKey: false })}
                    >
                      Clear Stored Key
                    </button>
                  </div>
                  <div className="stack stack-tight">
                    <div className="section-head">
                      <strong>Models</strong>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => updateEndpoint(index, {
                          models: [...endpoint.models, createEmptyEndpointModel()],
                        })}
                      >
                        Add Model
                      </button>
                    </div>
                    {endpoint.models.map((model, modelIndex) => (
                      <div key={`${endpoint.id}-${modelIndex}`} className="row gap-sm wrap-row">
                        <input
                          aria-label={`Custom endpoint model id ${index + 1}-${modelIndex + 1}`}
                          placeholder="model-id"
                          maxLength={CUSTOM_ENDPOINT_TEXT_MAX.modelId}
                          value={model.id}
                          onChange={(event) => updateEndpointModel(index, modelIndex, { id: event.target.value })}
                          disabled={busy}
                        />
                        <input
                          aria-label={`Custom endpoint model label ${index + 1}-${modelIndex + 1}`}
                          placeholder="Display label"
                          maxLength={CUSTOM_ENDPOINT_TEXT_MAX.modelLabel}
                          value={model.label}
                          onChange={(event) => updateEndpointModel(index, modelIndex, { label: event.target.value })}
                          disabled={busy}
                        />
                        <NumericInput
                          aria-label={`Custom endpoint model max output ${index + 1}-${modelIndex + 1}`}
                          min={1}
                          max={2_097_152}
                          value={model.maxOut}
                          onChange={(v) => updateEndpointModel(index, modelIndex, { maxOut: v })}
                          disabled={busy}
                        />
                        <NumericInput
                          aria-label={`Custom endpoint model context ${index + 1}-${modelIndex + 1}`}
                          min={1}
                          max={10_000_000}
                          value={model.ctx}
                          onChange={(v) => updateEndpointModel(index, modelIndex, { ctx: v })}
                          disabled={busy}
                        />
                        <button
                          type="button"
                          className="danger-button"
                          disabled={busy}
                          onClick={() => updateEndpoint(index, {
                            models: endpoint.models.filter((_, currentIndex) => currentIndex !== modelIndex),
                          })}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {localError ? <p className="error">{localError}</p> : null}
          {mutation.error ? <p className="error">{mutation.error.message}</p> : null}
          <div className="row gap-sm end">
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" onClick={submit} disabled={busy || query.isLoading}>
              {mutation.isPending ? "Saving..." : "Save API keys"}
            </button>
          </div>
        </div>
    </Dialog>
  );

  function updateEndpoint(index: number, patch: Partial<CustomEndpointDraft>) {
    setEndpointDrafts((current) => current.map((endpoint, currentIndex) => currentIndex === index ? { ...endpoint, ...patch } : endpoint));
    setEndpointsTouched(true);
  }

  function updateEndpointModel(index: number, modelIndex: number, patch: Partial<CustomEndpointDraft["models"][number]>) {
    setEndpointDrafts((current) => current.map((endpoint, currentIndex) => currentIndex === index ? {
      ...endpoint,
      models: endpoint.models.map((model, currentModelIndex) => currentModelIndex === modelIndex ? { ...model, ...patch } : model),
    } : endpoint));
    setEndpointsTouched(true);
  }
}

function createEmptyDrafts(): Record<ProviderId, string> {
  return {
    anthropic: "",
    "claude-code": "",
    "codex-bridge": "",
    deepseek: "",
    fireworks: "",
    gmicloud: "",
    google: "",
    moonshot: "",
    openai: "",
    xai: "",
    xiaomi: "",
    zai: "",
  };
}

function createEmptyTouched(): Record<ProviderId, boolean> {
  return {
    anthropic: false,
    "claude-code": false,
    "codex-bridge": false,
    deepseek: false,
    fireworks: false,
    gmicloud: false,
    google: false,
    moonshot: false,
    openai: false,
    xai: false,
    xiaomi: false,
    zai: false,
  };
}

function createEndpointDraft(endpoint: Awaited<ReturnType<typeof getProviderKeys>>["customEndpoints"][number]): CustomEndpointDraft {
  return {
    id: endpoint.id,
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    apiFormat: endpoint.apiFormat,
    authHeader: endpoint.authHeader,
    hasKey: endpoint.hasKey,
    keyNeedsReentry: endpoint.keyNeedsReentry === true,
    apiKeyInput: "",
    apiKeyMode: "keep",
    models: endpoint.models.length ? endpoint.models.map((model) => ({ ...model })) : [createEmptyEndpointModel()],
  };
}

function createNewEndpointDraft(): CustomEndpointDraft {
  return {
    id: `ep_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
    name: "",
    baseUrl: "",
    apiFormat: "chat-completions",
    authHeader: "Bearer",
    hasKey: false,
    keyNeedsReentry: false,
    apiKeyInput: "",
    apiKeyMode: "replace",
    models: [createEmptyEndpointModel()],
  };
}

function createEmptyEndpointModel() {
  return {
    id: "",
    label: "",
    maxOut: 4096,
    ctx: 128000,
  };
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(value, max));
}

function createUnknownStatusMap(): ProviderKeyStatusMap {
  const unknown: ProviderKeyStatus = { source: "none", configured: false, keyPreview: null, updatedAt: null };
  return {
    anthropic: unknown, "claude-code": unknown, "codex-bridge": unknown, deepseek: unknown, fireworks: unknown, gmicloud: unknown,
    google: unknown, moonshot: unknown, openai: unknown, xai: unknown, xiaomi: unknown, zai: unknown,
  };
}

function formatStatus(status: ProviderKeyStatus) {
  // The server reports an undecryptable stored key (secret rotation)
  // as source:"none" + needsReentry so older clients degrade to "Not configured".
  if (status.needsReentry) return "Stored key can no longer be read (server secret rotated) — re-enter it";
  if (status.source === "user") return status.keyPreview ? `Stored override ${status.keyPreview}` : "Stored override active";
  // The server's key: from its configuration, or shared by an administrator in Admin: Server settings.
  if (status.source === "server") return "Using the server's shared key";
  return "Not configured";
}
