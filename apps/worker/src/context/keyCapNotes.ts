import type { MergedKeys, NormalizedKeys } from "../../../api/src/domain/context/lorebookKeys";

/**
 * Which key limit bound on a worker's key write, for the run's details.
 * `growth` is a writer's own cap on additions (the
 * rolling diff's 20 synonyms), `max` the list cap every stored list obeys
 * (LOREBOOK_MAX_KEYS), `length` a key longer than the contract allows (no
 * editor save could carry it). `left` holds the keys that were not written.
 */
export interface KeyCapNote {
  entry: string;
  cappedBy: "growth" | "max" | "length";
  left: string[];
}

/** Collects notes per entry and limit; repeats of the same key are folded. */
export class KeyCapNotes {
  private readonly byEntry = new Map<string, KeyCapNote>();

  noteMerge(entry: string, merged: Pick<MergedKeys, "overGrowth" | "overCap" | "overLong">): void {
    this.add(entry, "growth", merged.overGrowth);
    this.add(entry, "max", merged.overCap);
    this.add(entry, "length", merged.overLong);
  }

  noteList(entry: string, normalized: Pick<NormalizedKeys, "overCap" | "overLong">): void {
    this.add(entry, "max", normalized.overCap);
    this.add(entry, "length", normalized.overLong);
  }

  list(): KeyCapNote[] {
    return [...this.byEntry.values()];
  }

  private add(entry: string, cappedBy: KeyCapNote["cappedBy"], keys: readonly string[]): void {
    if (keys.length === 0) return;
    const id = `${entry}\u0000${cappedBy}`;
    const note = this.byEntry.get(id) ?? { entry, cappedBy, left: [] };
    for (const key of keys) if (!note.left.some((k) => k.toLowerCase() === key.toLowerCase())) note.left.push(key);
    this.byEntry.set(id, note);
  }
}
