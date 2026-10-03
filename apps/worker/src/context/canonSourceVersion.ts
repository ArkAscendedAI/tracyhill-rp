import { createHash } from "node:crypto";
import type { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";

/** Include canon itself as well as the timestamp: two writes may share a millisecond. */
export function canonSourceVersion(entry: NonNullable<ReturnType<LorebookRepository["findById"]>>): string {
  return createHash("sha256").update(JSON.stringify([
    entry.id, entry.campaignId, entry.updatedAt, entry.name, entry.content, entry.comment,
    entry.keys, entry.keysSecondary, entry.knownBy, entry.tag, entry.isEnabled, entry.isConstant,
    entry.sealed, entry.compressedRefIds,
  ])).digest("hex");
}
