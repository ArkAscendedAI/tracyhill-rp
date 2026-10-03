// Pipeline prompts for the periodic auto kinds (sysprompt audit, repetition
// detection). The "V4" names date from the campaign-review era; the review
// monolith is retired and these two prompts are the only consumers left.

export const V4_SYSPROMPT_UPDATE_PROMPT = `You are reviewing and updating a collaborative fiction campaign's system prompt as part of a periodic automated review.

You will receive:
1. The current system prompt
2. The most recent transcript window (the turns played since the last review)

## Your Task

The system prompt is DURABLE behavioral firmware. Most reviews produce ZERO changes. Only update if the narrative has evolved in ways that change invariant rules:
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

1. **Carry forward ALL existing rules** — every existing rule must appear in your output. Update the frequency count to reflect how many times the pattern appeared in THIS window (0 if not seen). Rules you OMIT are NOT deleted: the server carries them forward unchanged (frequency 0) and flags the omission. To remove a rule deliberately — it was wrong, it duplicates another rule, or it describes the author's intentional style — re-emit it with "status": "retired" and a one-line "retire_reason". That is the only way a rule leaves the set on your say-so.
2. **Scan for NEW patterns** not covered by existing rules:
   - Flag any new repetitive pattern appearing 3+ times in the transcript window
   - Add it as a new rule (set status to "new")
3. **Re-evaluate rule_type for each existing rule** — if a "ban" rule turns out to describe a legitimate device that just got overused, downgrade to "limit" or "vary".

**DO NOT flag character AGENDA as repetition.** You are hunting PROSE tics — reused phrasings, sentence shapes, stock descriptions. A character who keeps pursuing the same goal, raising the same subject, or acting from a consistent motive across scenes is CHARACTERIZATION, not a tic (NPCs in this campaign have persistent drive sheets and are meant to push their own aims). Only flag it if the same *wording* is reused; never flag the recurring *intent or behavior* itself.

**DO NOT flag DRAMATIST PRESSURE as repetition.** A grounded timer, scheduled beat, concealed agenda, or antagonist scheme returning to create consequences is plot causality, not a prose tic. Judge the language used to deliver it, never the recurrence of the established pressure itself.

## Rule Types — choose carefully

Each rule MUST specify a rule_type. The type determines how the rule is rendered to the writing model:

- **ban** — Hard blacklist. NEVER use this construction. Reserve for invented model tics that have no legitimate literary purpose.
  - Use for: appositive frames the model invents ("the [adj] [noun] of a [person] who [clause]"), made-up "register" labels, specific manufactured constructions ("Not X. Not Y. [actual descriptor]" triple-elimination), category-naming in narration ("the Slayer's [mechanism]")
  - Test: would a human author writing carefully ever choose this? If no → ban.

- **limit** — Soft cap. The pattern is a legitimate literary device that becomes a tic when overused. Cap usage per scene.
  - Use for: signature character props (Doran's glasses, Petra's mug, Nessa's nail file), stylized physical anchors (BPM readings, hand-on-chest, eye contact through a mirror), distinctive rhythmic moves that work in moderation
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
- **retired**: An existing rule you are deliberately removing (see rule 1). Requires "retire_reason". Never use it for a rule that merely did not fire this window — that is frequency 0, not retirement.

When a previously "active" rule shows frequency 0 in this window, KEEP it "active" for ONE more window before downgrading to "dormant" on the next zero-frequency window. Track this through the rule's history — if the existing input shows the rule was already at 0 in the previous window AND it's at 0 again, set status to "dormant".

## Output

Output a JSON array — the COMPLETE ruleset (all existing + any new). Each rule:
- "pattern": the specific phrase, construction, or pattern (quote examples from the text)
- "category": one of "description", "dialogue", "action", "emotion", "structure"
- "rule_type": "ban", "limit", or "vary"
- "max_per_scene": integer (REQUIRED only for "limit", omit for ban/vary)
- "frequency": how many times it appeared in THIS window (0 if not seen)
- "replacement_guidance": a brief directive for what to do instead
- "status": "active", "new", "dormant", or "retired" (retired only for a deliberate removal, with "retire_reason")

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
    "pattern": "Doran removing/cleaning/replacing his glasses as emotional processing beat",
    "category": "description",
    "rule_type": "limit",
    "max_per_scene": 1,
    "frequency": 5,
    "replacement_guidance": "show Doran processing through other tells — voice register shifts, stillness, deliberate word choice, a hand on a book spine",
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
    "pattern": "Nessa's nail file as default physical business prop",
    "category": "description",
    "rule_type": "limit",
    "max_per_scene": 1,
    "frequency": 0,
    "replacement_guidance": "give Nessa varied physical business — adjusting clothing, gesturing, posture shifts, checking a mirror",
    "status": "dormant"
  }
]

Do not flag intentional character speech patterns or world-building terms. Output ONLY the JSON array.`;
