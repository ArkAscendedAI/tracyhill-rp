export const DEEP_REFRESH_LOREBOOK_PROMPT = `You are performing a comprehensive review of the lorebook for an ongoing roleplay campaign. Unlike incremental rolling diffs (which process a few turns), this is a THOROUGH audit across ALL recent sessions.

Read the analysis report and the full transcript, then emit a complete set of CRUD operations to bring the lorebook up to date.

Operations:
- CREATE: a new entry that should exist but doesn't. Provide name, tag, content, keys, AND known_by.
  - known_by: JSON array of character names who witnessed or were told this information. Use null for global/world knowledge (locations, lore, rules, character descriptions). Use specific names for events, conversations, or discoveries only certain characters witnessed.
- UPDATE: edit an existing entry whose content is outdated or incomplete. Provide entry_id, the COMPLETE new content (not a diff), and optionally known_by (if knowledge has spread to new characters).
- DELETE: remove an entry that is no longer canonical or has been superseded (rare).
- NOOP: no changes needed (unlikely for a deep refresh).

Guidelines:
- Be thorough: every character, location, faction, and event mentioned in the transcript should have a lorebook entry.
- Merge duplicate entries: if two entries describe the same thing, DELETE one and UPDATE the other.
- Update relationships and emotional states to reflect the latest narrative developments.
- Preserve entries that are still accurate — only emit UPDATE when content actually changed.
- Entries should be detailed (1-4 paragraphs) and self-contained.
- Choose appropriate tags: characters, locations, factions, events, lore, rules.
- Keys should include all names, aliases, and strongly associated terms.
- Set known_by carefully: character descriptions, locations, lore, and rules are global (null). Events and conversations are scoped to whoever was physically present or has been explicitly told on-screen.

Output ONLY a JSON array of operations. Example:
[
  {"op": "CREATE", "name": "New Character", "tag": "characters", "content": "...", "keys": ["name", "alias"], "known_by": null},
  {"op": "CREATE", "name": "Secret Meeting", "tag": "events", "content": "...", "keys": ["meeting"], "known_by": ["Character A", "Character B"]},
  {"op": "UPDATE", "entry_id": "existing_id", "content": "updated complete content...", "known_by": ["Character A", "Character B", "Character C"]},
  {"op": "DELETE", "entry_id": "obsolete_id"},
  {"op": "NOOP"}
]`;
