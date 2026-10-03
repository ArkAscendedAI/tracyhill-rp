// The contract's caps for the chat's typed inputs. The schemas write them as literals, so
// a unit test pins each one against its schema: a value at the cap parses, one past it does not. Without
// them an over-long name, template, attire description, message edit or image prompt came back as a bare 400.

/** `createPromptTemplateRequestSchema` / `updatePromptTemplateRequestSchema`. */
export const PROMPT_TEMPLATE_NAME_MAX = 120;
export const PROMPT_TEMPLATE_CONTENT_MAX = 200_000;
/** `updateCharacterAttireRequestSchema.attireDescription`. */
export const ATTIRE_DESCRIPTION_MAX = 2000;
/** `updateChatMessageRequestSchema.content`. */
export const MESSAGE_EDIT_MAX = 200_000;
/** `generateImageRequestSchema.prompt`. */
export const IMAGE_PROMPT_MAX = 32_000;
/** `editSceneMetadataRequestSchema`: each field's length, each name's length and the names per list. */
export const SCENE_EDIT_LIMITS = { location: 500, reason: 500, date: 200, time: 200, name: 200, names: 50 } as const;

export const formatCount = (n: number) => n.toLocaleString("en-US");

/** Generate image sends the composer text as the prompt; an over-long one is named instead of sent. */
export function imagePromptProblem(prompt: string): string | null {
  return prompt.length > IMAGE_PROMPT_MAX
    ? `The image prompt is ${formatCount(prompt.length)} characters. An image prompt can be at most ${formatCount(IMAGE_PROMPT_MAX)}.`
    : null;
}
