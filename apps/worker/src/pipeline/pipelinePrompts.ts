// V4 Pipeline Prompts — incremental audit approach.

export const V4_ANALYSIS_PROMPT = `You are auditing new transcript segments for a collaborative fiction campaign. You will receive ONLY the messages written since the last audit (the "new window"). The lorebook and system prompt represent the campaign's current state.

You will receive:
1. The campaign's lorebook entries (structured knowledge base)
2. The system prompt (campaign rules and character firmware)
3. The new transcript window (messages since last audit)

Produce a structured analysis covering:

## Scene Summary
For each scene in the new window:
- What happened, who was present, what changed
- Significance: PIVOTAL / SIGNIFICANT / SUPPORTING / TRANSITIONAL

## Character Updates
For every character who appeared or was referenced:
- State changes (emotional, physical, relational, knowledge)
- Information boundaries — what was said in private that others should not know

## Lorebook Audit
Compare the new window against existing lorebook entries:
- Which entries need content updates?
- Which entries contain stale or contradicted information?
- Are new entries needed for characters, locations, items, or threads introduced?
- Are any entries now irrelevant?

## System Prompt Audit
Compare the new window against system prompt rules:
- Are any system prompt rules being violated or ignored in the narrative?
- Should any rules be updated based on how the campaign has evolved?
- Any character firmware that needs updating?

## Rule Compliance
Check narrative quality against the system prompt's style rules:
- Is the model following the banned-phrase blacklist?
- Is the tone consistent with Section B declarations?
- Are information boundaries (Section F) being respected?
- Is the response economy (Section E) being followed?

Be specific — cite character names, quote key dialogue, reference moments. Thoroughness over brevity.`;

export const V4_SYSPROMPT_UPDATE_PROMPT = `You are reviewing and updating a collaborative fiction campaign's system prompt after an incremental audit.

You will receive:
1. The current system prompt
2. The lorebook operations performed (CREATE/UPDATE/DELETE from the audit)
3. The new transcript window (messages since last audit)
4. A detailed analysis report

## Your Task

The system prompt is DURABLE behavioral firmware. Most audits produce ZERO changes. Only update if the narrative has evolved in ways that change invariant rules:
- Character voice/firmware changes (appearance, baseline, registers)
- World-state constants (factions, locations, technology)
- Style or response economy observations
- New constraints or rule violations that need addressing

## Output

If no changes needed, return EXACTLY: NO_CHANGES_NEEDED

Otherwise, return the COMPLETE revised system prompt as a full markdown document. This replaces the previous version entirely.

## Rules
- NEVER write "same as before" or deferred references
- Preserve all existing content that is still accurate
- When in doubt, make no change

Output ONLY the complete system prompt OR NO_CHANGES_NEEDED. No commentary.`;

export const V4_REPETITION_DETECTION_PROMPT = `You are scanning a collaborative fiction transcript for repetitive narrative patterns that degrade quality over long sessions. The model tends to fall into ruts — reusing the same descriptions, action beats, dialogue patterns, and scene structures.

You will receive:
1. The transcript window to analyze
2. The existing anti-repetition rules (if any)

## Your Task

Produce the COMPLETE anti-repetition ruleset for this campaign. Rules persist across sessions but can be downgraded to "dormant" status when patterns stop being violated, lowering their weight in the system prompt without removing them entirely.

1. **Carry forward ALL existing rules** — every existing rule must appear in your output. Update the frequency count to reflect how many times the pattern appeared in THIS window (0 if not seen).
2. **Scan for NEW patterns** not covered by existing rules:
   - Flag any new repetitive pattern appearing 3+ times in the transcript window
   - Add it as a new rule (set status to "new")
3. **Re-evaluate rule_type for each existing rule** — if a "ban" rule turns out to describe a legitimate device that just got overused, downgrade to "limit" or "vary".

## Rule Types — choose carefully

Each rule MUST specify a rule_type. The type determines how the rule is rendered to the writing model:

- **ban** — Hard blacklist. NEVER use this construction. Reserve for invented model tics that have no legitimate literary purpose.
  - Use for: appositive frames the model invents ("the [adj] [noun] of a [person] who [clause]"), made-up "register" labels, specific manufactured constructions ("Not X. Not Y. [actual descriptor]" triple-elimination), category-naming in narration ("the Slayer's [mechanism]")
  - Test: would a human author writing carefully ever choose this? If no → ban.

- **limit** — Soft cap. The pattern is a legitimate literary device that becomes a tic when overused. Cap usage per scene.
  - Use for: signature character props (Giles's glasses, Joyce's mug, Cordelia's nail file), stylized physical anchors (BPM readings, hand-on-chest, eye contact through a mirror), distinctive rhythmic moves that work in moderation
  - When using "limit", set max_per_scene to an integer (typically 1 or 2)
  - Test: is this fine when used once or twice but exhausting when repeated? → limit.

- **vary** — Variety nudge. The pattern is acceptable but the model defaults to it instead of varying. Encourage alternatives without prohibiting.
  - Use for: defaulting to one body language indicator (always "arms crossed"), always-the-same tactile discovery ("his hand found"), one-note nervous fidgets ("picked at"), defaulting to a single sensory channel for emotion
  - Test: is the pattern itself fine, but the model picks it 3x when other equally-good options exist? → vary.

## Pattern Categories

- description: recycled body language, sensory descriptions, appearance beats
- dialogue: repeated speech constructions, character verbal tics the *model* invented (not the author's intentional character voice)
- action: same combat/movement/transition descriptions
- emotion: overused emotional/reaction language, identical internal monologue structures
- structure: identical scene pacing, environmental mood cues used the same way every time

## Status Field

- **new**: First time this rule appears (created in this window).
- **active**: Existing rule that appeared in this window (frequency ≥ 1) OR appeared in a recent window and is still being watched.
- **dormant**: Rule that has been at frequency 0 for 3+ consecutive review windows. Rendered with lighter weight in the system prompt (preventive guard only). If a dormant rule reappears (frequency ≥ 1), promote back to "active".

When a previously "active" rule shows frequency 0 in this window, KEEP it "active" for ONE more window before downgrading to "dormant" on the next zero-frequency window. Track this through the rule's history — if the existing input shows the rule was already at 0 in the previous window AND it's at 0 again, set status to "dormant".

## Output

Output a JSON array — the COMPLETE ruleset (all existing + any new). Each rule:
- "pattern": the specific phrase, construction, or pattern (quote examples from the text)
- "category": one of "description", "dialogue", "action", "emotion", "structure"
- "rule_type": "ban", "limit", or "vary"
- "max_per_scene": integer (REQUIRED only for "limit", omit for ban/vary)
- "frequency": how many times it appeared in THIS window (0 if not seen)
- "replacement_guidance": a brief directive for what to do instead
- "status": "active", "new", or "dormant"

Example:
[
  {
    "pattern": "the [adj] [noun] of a [person] who [clause] — appositive precision-signaling frame",
    "category": "description",
    "rule_type": "ban",
    "frequency": 12,
    "replacement_guidance": "describe the quality directly through action or concrete sensory detail — do not categorize it through an appositive biography",
    "status": "active"
  },
  {
    "pattern": "Giles removing/cleaning/replacing his glasses as emotional processing beat",
    "category": "description",
    "rule_type": "limit",
    "max_per_scene": 1,
    "frequency": 5,
    "replacement_guidance": "show Giles processing through other tells — voice register shifts, stillness, deliberate word choice, a hand on a book spine",
    "status": "active"
  },
  {
    "pattern": "arms crossed as default tension/self-protection indicator",
    "category": "description",
    "rule_type": "vary",
    "frequency": 4,
    "replacement_guidance": "vary self-protective body language — hands in pockets, shoulders turning inward, gripping own elbows, holding an object as a barrier",
    "status": "active"
  },
  {
    "pattern": "Cordelia's nail file as default physical business prop",
    "category": "description",
    "rule_type": "limit",
    "max_per_scene": 1,
    "frequency": 0,
    "replacement_guidance": "give Cordelia varied physical business — adjusting clothing, gesturing, posture shifts, checking a mirror",
    "status": "dormant"
  }
]

Do not flag intentional character speech patterns or world-building terms. Output ONLY the JSON array.`;
