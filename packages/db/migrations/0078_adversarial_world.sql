-- Adversarial World phases 3-6.
--
-- Everything here is INERT at the shipped defaults (worldStance 1). Each
-- mechanism is gated on stance in code, so a campaign that never touches the dial
-- never registers a threat, never records a consequence, never advances a clock,
-- and never promotes a nemesis. Adding the tables costs nothing until someone
-- opts in.
--
-- The through-line for all four phases is the same as phases 1-2: move authority
-- out of the model and into code. Prose can ASK a model to follow through on a
-- threat, honour a death, or escalate a rival — a positivity-biased model will
-- reliably decline all three. State it owns and cannot rewrite is the only
-- version that holds.

-- ─── Phase 3: threat fuse ────────────────────────────────────────────────────
-- A stated threat is a commitment with a deadline. The prose rule alone is a
-- request; this makes it checkable. Two opportunities, then the verifier has
-- something concrete to flag and the Dramatist has something to arm.
CREATE TABLE IF NOT EXISTS active_threats (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  session_id TEXT,
  source_character TEXT NOT NULL,
  target TEXT NOT NULL,
  stated_act TEXT NOT NULL,
  -- Decremented on each of the SOURCE character's opportunities, not on every
  -- turn: a threat from someone off-stage should not burn its fuse while they
  -- are absent.
  opportunities_remaining INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'armed' CHECK (status IN ('armed', 'attempted', 'defused', 'expired')),
  -- How the threat left 'armed', for the report and for the audit trail.
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS active_threats_campaign_status_idx ON active_threats (campaign_id, status);

-- ─── Phase 4: consequence ledger ─────────────────────────────────────────────
-- Regeneration and variants are plot armour: any death the model narrates can be
-- swiped away, and community RP has no answer to this because it does not own the
-- state. We do. A recorded consequence is re-injected as a constraint on
-- regenerate/variant paths, so a re-roll cannot resurrect.
CREATE TABLE IF NOT EXISTS campaign_consequences (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('death', 'maiming', 'loss', 'ruin')),
  subject TEXT NOT NULL,
  detail TEXT NOT NULL,
  -- The message that established it. Kept for provenance; deliberately NOT a
  -- foreign key, because deleting the message must not erase the fact.
  message_id TEXT,
  -- Aftermath choice for a death: survive with permanent cost, or transfer to
  -- another character with the death standing as canon. NULL until chosen.
  aftermath TEXT CHECK (aftermath IN ('consequence_survival', 'character_transfer')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS campaign_consequences_campaign_idx ON campaign_consequences (campaign_id, created_at);

-- ─── Phase 5: emotional inertia + redemption exemption ───────────────────────
-- "A position changes only when a cost is imposed" is a request in prose and
-- arithmetic here. One apology cannot flip a counter.
ALTER TABLE character_drives ADD COLUMN grudge INTEGER NOT NULL DEFAULT 0;
ALTER TABLE character_drives ADD COLUMN trust INTEGER NOT NULL DEFAULT 0;
-- Designated true-evil antagonists are excluded from any moral-complexity or
-- anti-flatness norm. Without this, "every cruel character has principles" —
-- good medicine for the general cast — quietly manufactures the sympathetic
-- villain this whole feature exists to remove.
ALTER TABLE character_drives ADD COLUMN redemption_exempt INTEGER NOT NULL DEFAULT 0;

-- ─── Phase 6: nemesis records + threat clocks ────────────────────────────────
-- Nemesis: the antagonist who beat <user> should come back changed and remember
-- it. Persistent rank/scars/familiarity on the existing sheet rather than a new
-- table, so it rides the drive-sheet machinery already in place.
ALTER TABLE character_drives ADD COLUMN nemesis_rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE character_drives ADD COLUMN scars_json TEXT;
-- Encounter count with <user>. Drives who resurfaces: a familiar antagonist is
-- more prominent than a fresh one, which is what makes a recurring villain feel
-- earned rather than randomly re-rolled.
ALTER TABLE character_drives ADD COLUMN familiarity INTEGER NOT NULL DEFAULT 0;

-- Clocks/fronts. The point is that a clock advances whether or not <user> engages
-- with it — a threat that only progresses when looked at is not a threat. The
-- impulse string is injected while the clock is live so the offscreen antagonist
-- acts in character rather than idling.
CREATE TABLE IF NOT EXISTS threat_clocks (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  name TEXT NOT NULL,
  impulse TEXT NOT NULL,
  filled INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 6,
  -- Which character or faction drives it; used to route the impulse injection.
  owner_character TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'filled', 'resolved', 'abandoned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threat_clocks_campaign_status_idx ON threat_clocks (campaign_id, status);
