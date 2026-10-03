/**
 * Decides what the Template Library textarea does when a refetch delivers a
 * (possibly different) server value. The draft is seeded only while
 * it still equals what it was last seeded from; an unsaved edit is never
 * replaced, and a server-side change under an unsaved edit is reported so the
 * user can reload it deliberately (the lorebook editor's `serverChanged`).
 */
export function resolveWizardTemplateSeed(input: { seeded: string | null; draft: string; incoming: string }): { seed: boolean; serverChanged: boolean } {
  const dirty = input.seeded !== null && input.draft !== input.seeded;
  if (!dirty) return { seed: true, serverChanged: false };
  return { seed: false, serverChanged: input.incoming !== input.seeded };
}
