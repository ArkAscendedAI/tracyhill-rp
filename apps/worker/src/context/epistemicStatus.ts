/**
 * Shared epistemic-status discipline for every worker prompt that writes canon
 * from the transcript.
 *
 * WHY THIS EXISTS. All of these prompts treated "the transcript is the sole
 * source of truth" as "text in the transcript is fact." In a campaign with
 * reality-warping artifacts, forced visions, telepaths and shapeshifters those come apart
 * constantly, and it produced the two largest canon repairs this project has
 * needed:
 *
 *   - A character's sincere false belief (she had killed her father) plus an
 *     illusion she attacked believing it real, both recorded as flat history
 *     across three entries. She then repeated it for months because retrieval
 *     kept handing the model the wrong version.
 *   - A death staged inside a forced vision recorded as real history. The
 *     reveal naming it a projection sat FOUR messages after the death scene —
 *     a worker whose window ended in that gap could not have known.
 *
 * Both were well-formed ops with valid basis quotes. Every rule in the prompts
 * was satisfied. Nothing asked whether the event happened.
 *
 * ESCAPE HATCH, DELIBERATELY CLOSED. The final paragraph is not filler. A
 * positivity-biased model handed "be careful what you record as real" will
 * reach for it to downgrade atrocities it would rather not write — logging a
 * murder as "reported" and quietly draining the world of consequence. The rule
 * is one-directional and says so.
 */

/** Full discipline — for prompts that AUTHOR canon from transcript text. */
export const EPISTEMIC_STATUS_RULE = `
EPISTEMIC STATUS — ESTABLISH BEFORE YOU RECORD.
Text in the transcript is not automatically fact in the world. This story may contain visions, projections, illusions, dreams, telepathic constructs, simulations, impersonation, disguise, possession, deception, and characters who sincerely believe false things. An event rendered in full sensory detail may never have occurred.

Before recording any event as history, establish that it happened in baseline reality:
- Occurred inside a vision, projection, dream, hallucination, illusion, simulation, or telepathic construct: the entry's FIRST LINE says so, names the technique and its author if known, and states what is true instead. Do not bury this mid-entry.
- A character's claim, belief, boast, accusation, or memory: attribute it. "X states that Y happened" is a different fact from "Y happened." Record the statement. Record its content as fact only where the story separately establishes it.
- Speaker or actor identity in question (impersonation, shapeshifting, disguise, possession, forgery): record who APPEARED to act, not who acted.
- An extraordinary event whose nature this window does not settle — a death, a betrayal, a resurrection, a revelation arriving without corroboration: record what was SHOWN or REPORTED, not what occurred. The framing that explains it may sit outside your window entirely.

This rule travels in ONE direction: it stops unreal events from entering canon as real. It is not licence to hedge. When the story establishes that something happened, record it plainly and in full — however violent, cruel, or final it was. Downgrading an established event to "reported" is the same failure as promoting a vision to history.`;

/** Verdict-side variant — for prompts that JUDGE findings rather than author canon. */
export const EPISTEMIC_STATUS_VERDICT_RULE = `
EPISTEMIC STATUS. Transcript evidence depicting an event does not establish that it occurred: this story may contain visions, illusions, impersonation, deception, and sincere false belief, and the framing that reveals one often sits outside the excerpts you were given. An entry that departs from a transcript excerpt may be RIGHT — correctly recording baseline reality against an excerpt that is the unreal version. Weigh which of the two is the world's truth before treating the divergence as an error. This does not license hedging: where the story settles that an event happened, an entry recording it plainly is correct and a finding against it fails.`;
