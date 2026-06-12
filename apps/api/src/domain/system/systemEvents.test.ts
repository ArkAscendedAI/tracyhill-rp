import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ackSystemEvents,
  countUnackedSystemEvents,
  listSystemEvents,
  recordSystemEvent,
  resetSystemEventsForTest,
} from "./systemEvents";

describe("systemEvents", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-sysevents-"));
    const dbFile = path.join(dir, "test.sqlite");
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    resetSystemEventsForTest(db);
  });

  afterEach(() => {
    resetSystemEventsForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records, lists, counts, and acknowledges events", () => {
    recordSystemEvent({ userId: "u1", source: "embed_query", severity: "error", message: "query embedding failed (google:gemini-embedding-2): fetch failed" });
    recordSystemEvent({ userId: "u1", source: "hyde", message: "HyDE failed" });
    recordSystemEvent({ userId: "u2", source: "researcher", message: "other user's event" });

    const events = listSystemEvents("u1", { unackedOnly: true });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.source).sort()).toEqual(["embed_query", "hyde"]);
    expect(countUnackedSystemEvents("u1")).toBe(2);

    const acked = ackSystemEvents("u1");
    expect(acked).toBe(2);
    expect(countUnackedSystemEvents("u1")).toBe(0);
    // u2's event untouched — user scoping holds.
    expect(countUnackedSystemEvents("u2")).toBe(1);
  });

  it("throttles identical events within the window", () => {
    for (let i = 0; i < 5; i++) {
      recordSystemEvent({ userId: "u1", source: "embed_query", message: "same outage message" });
    }
    expect(listSystemEvents("u1")).toHaveLength(1);
    // A different message is its own event.
    recordSystemEvent({ userId: "u1", source: "embed_query", message: "different message" });
    expect(listSystemEvents("u1")).toHaveLength(2);
  });

  it("never throws when uninitialized", () => {
    resetSystemEventsForTest(null);
    expect(() => recordSystemEvent({ userId: "u1", source: "pipeline", message: "no db" })).not.toThrow();
    expect(listSystemEvents("u1")).toEqual([]);
    expect(ackSystemEvents("u1")).toBe(0);
  });
});
