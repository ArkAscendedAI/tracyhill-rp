import type {
  CharacterAttireListResponse,
  CharacterAttireRecord,
  UpdateCharacterAttireRequest,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export function getCharacterAttire(campaignId: string, characterName: string) {
  return apiFetch<CharacterAttireRecord>(`/api/character-attire/campaigns/${campaignId}/attire/${encodeURIComponent(characterName)}`);
}

export function updateCharacterAttire(campaignId: string, characterName: string, payload: UpdateCharacterAttireRequest) {
  return apiFetch<CharacterAttireRecord>(`/api/character-attire/campaigns/${campaignId}/attire/${encodeURIComponent(characterName)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}
