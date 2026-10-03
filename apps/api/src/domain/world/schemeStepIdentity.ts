import { createHash } from "node:crypto";
import type { AntagonistScheme } from "@tracyhill-rp/contracts";

/** A changed scheme or consumed step must never inherit an older countdown. */
export function schemeStepKey(scheme: AntagonistScheme): string {
  return createHash("sha256").update(JSON.stringify({
    target: scheme.targetCitation, step: scheme.currentStep, value: scheme.steps[scheme.currentStep],
  })).digest("hex");
}
