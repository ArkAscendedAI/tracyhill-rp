import type { DramatistState } from "@tracyhill-rp/contracts";

export type DramatistIntensity = "restrained" | "standard" | "bold";
export type DramatistGrant =
  | { kind: "fizzle"; severity: null }
  | { kind: "texture"; severity: 0 }
  | { kind: "complication"; severity: 1 | 2 }
  | { kind: "escalation"; severity: 3 };

export type DramatistBand = {
  kind: DramatistGrant["kind"];
  severity: DramatistGrant["severity"];
  min: number;
  max: number;
  width: number;
};

export type PacingResolution = {
  roll: number;
  grant: DramatistGrant;
  bands: DramatistBand[];
  modifiers: {
    pressureShift: number;
    scenesSinceFire: number;
    fizzleStreak: number;
    complicationCooldown: number;
    cooldownSuppressed: boolean;
  };
};

type BandWidths = [fizzle: number, texture: number, complication1: number, complication2: number, escalation: number];

// All tuning lives here. A roll grants permission and scale only; it never
// authors content. Behind-the-Curtain telemetry makes these constants safe to
// tune after real campaign data exists.
//
// UNITS: the ledger advances once per Dramatist TICK (scenesElapsed defaults
// to 1), and a tick runs every tickEveryNthRollingDiff rolling diffs — at the
// default cadence one ledger step ≈ 8 played turns. The state field names keep
// the shipped contract ("scenesSinceFire"); read them as ticks.
export const DRAMATIST_BASE_BANDS: Readonly<Record<DramatistIntensity, BandWidths>> = {
  restrained: [35, 35, 20, 8, 2],
  standard: [25, 30, 25, 15, 5],
  bold: [15, 25, 30, 22, 8],
};
export const DRAMATIST_COMPLICATION_COOLDOWN_TICKS = 3;

export const EMPTY_DRAMATIST_STATE: DramatistState = {
  scenesSinceFire: 0,
  lastRoll: null,
  lastFireAt: null,
  fizzleStreak: 0,
  complicationCooldown: 0,
};

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function shiftedWidths(intensity: DramatistIntensity, state: DramatistState): { widths: BandWidths; pressureShift: number; cooldownSuppressed: boolean } {
  const base = [...DRAMATIST_BASE_BANDS[intensity]] as BandWidths;
  const desiredShift = Math.min(24, state.scenesSinceFire * 2 + state.fizzleStreak * 3);
  const fromFizzle = Math.min(base[0] - 5, desiredShift);
  base[0] -= fromFizzle;
  const remaining = desiredShift - fromFizzle;
  const fromTexture = Math.min(Math.max(0, base[1] - 10), remaining);
  base[1] -= fromTexture;
  const pressureShift = fromFizzle + fromTexture;
  base[2] += Math.floor(pressureShift * 0.7);
  base[3] += Math.floor(pressureShift * 0.25);
  base[4] += pressureShift - Math.floor(pressureShift * 0.7) - Math.floor(pressureShift * 0.25);

  if (state.complicationCooldown <= 0) return { widths: base, pressureShift, cooldownSuppressed: false };

  // A severity-2+ fire establishes a hard quiet floor. Preserve entropy by
  // redistributing the suppressed pressure between fizzle and texture.
  const suppressed = base[2] + base[3] + base[4];
  base[0] += Math.floor(suppressed * 0.4);
  base[1] += suppressed - Math.floor(suppressed * 0.4);
  base[2] = 0;
  base[3] = 0;
  base[4] = 0;
  return { widths: base, pressureShift, cooldownSuppressed: true };
}

export function buildDramatistBands(intensity: DramatistIntensity, state: DramatistState): { bands: DramatistBand[]; pressureShift: number; cooldownSuppressed: boolean } {
  const { widths, pressureShift, cooldownSuppressed } = shiftedWidths(intensity, state);
  const definitions: Array<Pick<DramatistBand, "kind" | "severity">> = [
    { kind: "fizzle", severity: null },
    { kind: "texture", severity: 0 },
    { kind: "complication", severity: 1 },
    { kind: "complication", severity: 2 },
    { kind: "escalation", severity: 3 },
  ];
  let cursor = 1;
  const bands = definitions.map((definition, index) => {
    const width = widths[index] ?? 0;
    const band = { ...definition, min: cursor, max: cursor + width - 1, width };
    cursor += width;
    return band;
  });
  return { bands, pressureShift, cooldownSuppressed };
}

export function resolveDramatistPacing(roll: number, intensity: DramatistIntensity, state: DramatistState): PacingResolution {
  const normalizedRoll = clampInt(roll, 1, 100);
  const { bands, pressureShift, cooldownSuppressed } = buildDramatistBands(intensity, state);
  const band = bands.find((candidate) => candidate.width > 0 && normalizedRoll >= candidate.min && normalizedRoll <= candidate.max) ?? bands[1]!;
  return {
    roll: normalizedRoll,
    grant: { kind: band.kind, severity: band.severity } as DramatistGrant,
    bands,
    modifiers: {
      pressureShift,
      scenesSinceFire: state.scenesSinceFire,
      fizzleStreak: state.fizzleStreak,
      complicationCooldown: state.complicationCooldown,
      cooldownSuppressed,
    },
  };
}

export function advanceDramatistState(
  state: DramatistState,
  input: { roll: number; scenesElapsed?: number; firedSeverity: 0 | 1 | 2 | 3 | null; fizzled: boolean; now?: string },
): DramatistState {
  const scenesElapsed = clampInt(input.scenesElapsed ?? 1, 1, 100);
  const cooled = Math.max(0, state.complicationCooldown - scenesElapsed);
  if (input.firedSeverity != null && input.firedSeverity >= 1) {
    return {
      scenesSinceFire: 0,
      lastRoll: clampInt(input.roll, 1, 100),
      lastFireAt: input.now ?? new Date().toISOString(),
      fizzleStreak: 0,
      complicationCooldown: input.firedSeverity >= 2 ? DRAMATIST_COMPLICATION_COOLDOWN_TICKS : cooled,
    };
  }
  if (input.firedSeverity === 0) {
    // Texture landed: it clears the no-fire alert streak but NOT the drought
    // ledger — flavor must never suppress the pressure that earns real
    // complications, or the wide texture band perpetually resets the ratchet.
    return {
      scenesSinceFire: state.scenesSinceFire + scenesElapsed,
      lastRoll: clampInt(input.roll, 1, 100),
      lastFireAt: state.lastFireAt,
      fizzleStreak: 0,
      complicationCooldown: cooled,
    };
  }
  return {
    scenesSinceFire: state.scenesSinceFire + scenesElapsed,
    lastRoll: clampInt(input.roll, 1, 100),
    lastFireAt: state.lastFireAt,
    fizzleStreak: input.fizzled ? state.fizzleStreak + 1 : state.fizzleStreak,
    complicationCooldown: cooled,
  };
}
