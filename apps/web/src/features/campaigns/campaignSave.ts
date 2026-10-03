import type { UpdateCampaignRequest } from "@tracyhill-rp/contracts";

/** The campaign editor's fields at Save time. */
export type CampaignEditorFields = {
  name: string;
  folderId: string;
  version: number;
  initialVersion: number;
  systemPrompt: string;
};

export type CampaignSavePlan =
  | { kind: "send"; payload: UpdateCampaignRequest }
  | { kind: "refuse"; message: string };

/**
 * What Save does for the campaign editor. An emptied system prompt over a stored one is refused with a
 * message and nothing is sent: the server reads a blank prompt as "no change"
 * (campaignService.update, so a client that never loaded the prompt cannot wipe it) and has no way to clear
 * one, so sending it kept the old prompt while the Save looked like it had emptied it. A campaign that has
 * no prompt saves with the prompt left blank, as before.
 */
export function planCampaignSave(fields: CampaignEditorFields, storedSystemPrompt: string): CampaignSavePlan {
  if (!fields.systemPrompt.trim() && storedSystemPrompt.trim()) {
    return { kind: "refuse", message: "A campaign's system prompt cannot be saved empty, so nothing was saved. Paste the prompt back or write a new one; History shows the saved prompt." };
  }
  return {
    kind: "send",
    payload: {
      name: fields.name.trim(),
      folderId: fields.folderId === "root" ? null : fields.folderId,
      ...(fields.version !== fields.initialVersion ? { version: fields.version } : {}),
      systemPrompt: fields.systemPrompt,
    },
  };
}
