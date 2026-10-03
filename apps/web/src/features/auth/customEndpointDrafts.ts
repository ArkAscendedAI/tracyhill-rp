// Pre-save checks for the custom endpoints of the Providers dialog. Pure, so
// they are unit-tested without React.

import { customEndpointInputSchema, customEndpointModelSchema, updateProviderKeysRequestSchema } from "@tracyhill-rp/contracts";

import { arrayMaxLength, stringMaxLength } from "../lorebook/contractBounds";

// The contract's limits: a save past one came back as a bare "invalid provider key
// request". The text inputs stop at theirs; the two counts are named before saving (Android 1.3.0's sentences).
export const CUSTOM_ENDPOINT_TEXT_MAX = {
  name: stringMaxLength(customEndpointInputSchema.shape.name),
  modelId: stringMaxLength(customEndpointModelSchema.shape.id),
  modelLabel: stringMaxLength(customEndpointModelSchema.shape.label),
};
const ENDPOINTS_MAX = arrayMaxLength(updateProviderKeysRequestSchema.innerType().shape.customEndpoints) ?? Infinity;
const MODELS_MAX = arrayMaxLength(customEndpointInputSchema.shape.models) ?? Infinity;

export type CustomEndpointDraftFields = { name: string; baseUrl: string; models?: ReadonlyArray<{ id: string }> };

/** Why the endpoint drafts cannot be saved as they are, or null when they can. */
export function customEndpointDraftsProblem(drafts: readonly CustomEndpointDraftFields[]): string | null {
  const incomplete = drafts.filter((endpoint) => !endpoint.name.trim() || !endpoint.baseUrl.trim());
  if (incomplete.length) {
    // Saves are a full-array replace — filtering incomplete drafts out used
    // to permanently delete a half-edited endpoint with no warning.
    return "Each custom endpoint needs a name and base URL (remove the endpoint explicitly if you meant to delete it)";
  }
  if (drafts.length > ENDPOINTS_MAX) return `At most ${ENDPOINTS_MAX} custom endpoints can be saved. Delete one before saving.`;
  // The server refuses the whole save for one bad base URL (customEndpointInputSchema:
  // https only, no userinfo), so say which endpoint and why before sending.
  for (const endpoint of drafts) {
    const problem = baseUrlProblem(endpoint.name.trim(), endpoint.baseUrl.trim());
    if (problem) return problem;
    // A model row without an id is dropped on save, so only the rows that are sent count.
    const models = (endpoint.models ?? []).filter((model) => model.id.trim()).length;
    if (models > MODELS_MAX) return `Custom endpoint "${endpoint.name.trim()}" has ${models} models. An endpoint can have at most ${MODELS_MAX}.`;
  }
  return null;
}

function baseUrlProblem(name: string, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return `Custom endpoint "${name}" has a base URL that is not a valid URL. It must start with https://.`;
  }
  if (url.protocol === "http:") {
    return `Custom endpoint "${name}" needs a base URL that starts with https://. Plain http:// is refused, even for a server on your own network.`;
  }
  if (url.protocol !== "https:") return `Custom endpoint "${name}" needs a base URL that starts with https://.`;
  if (url.username || url.password) {
    return `Custom endpoint "${name}" has a user name or password in its base URL. Put the key in the API Key field instead.`;
  }
  return null;
}
