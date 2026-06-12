import { describe, expect, it } from "vitest";

import { contextSettingsSchema, contextSettingsUpdateSchema } from "@tracyhill-rp/contracts";
import { createDatabaseClient, readMigrations } from "@tracyhill-rp/db";

/**
 * Migration integrity guard for the context-settings JSON.
 *
 * Background: migration 0054 renamed the `presenceValidator*` keys to
 * `sceneValidator*` using `json_set(target, path, json_extract(src, path))`.
 * SQLite's `json_extract` coerces a JSON boolean to a SQLite integer (0/1), and
 * `json_set` then stores it back as a JSON *number* — producing
 * `"sceneValidatorAutoRegen": 0` instead of `false`, which failed the
 * `z.boolean()` contract and broke the Engine popover's Auto-regen toggle.
 *
 * This test seeds a settings blob containing EVERY ContextSettings dial before
 * the later migrations run, applies every migration, and after each one asserts
 * the settings JSON still parses against the contract AND every field still has
 * its correct JSON storage type (boolean stays boolean, number stays number,
 * string stays string, array stays array — never silently coerced). Any future
 * migration that corrupts any dial fails here, naming the offending migration.
 *
 * The seed is kept in sync with the schema automatically: a meta-assertion
 * fails if a new dial is added to ContextSettings without being added here.
 */

// The 0054 rename: legacy key (used in the pre-0054 seed) -> current key.
const RENAMED: Record<string, string> = {
  sceneValidatorEnabled: "presenceValidatorEnabled",
  sceneValidatorModel: "presenceValidatorModel",
  sceneValidatorAutoRegen: "presenceValidatorAutoRegen",
};

// A comprehensive, correctly-typed value for every ContextSettings dial.
// Booleans are real booleans, numbers are numbers, strings are strings, arrays
// are arrays. The three validator fields use their LEGACY `presenceValidator*`
// names because the seed is inserted before migration 0054 renames them — that
// is what exercises the rename path.
const SEED_SETTINGS: Record<string, unknown> = {
  mode: "hybrid",
  retrievalBudgetTokens: 4000,
  semanticTopK: 20,
  semanticThreshold: 0.25,
  scanDepth: 4,
  contextBudgetTokens: 200000,
  guaranteedMessageCount: 20,
  embeddingModel: "openai:text-embedding-3-large",
  researcherEnabled: true,
  researcherModel: "claude-sonnet-4-6-bridge",
  researcherMaxPicks: 16,
  hydeEnabled: false,
  hydeModel: "claude-haiku-4-5-bridge",
  rollingEnabled: true,
  rollingCadence: 4,
  rollingModel: "claude-haiku-4-5-bridge",
  presenceValidatorEnabled: true, // -> sceneValidatorEnabled (0054)
  presenceValidatorModel: "claude-haiku-4-5-bridge", // -> sceneValidatorModel (0054)
  presenceValidatorAutoRegen: false, // -> sceneValidatorAutoRegen (0054)
  attireTrackingEnabled: true,
  attireStaleTurnThreshold: 10,
  pipelineAutoEnabled: true,
  rollingDiffCharThreshold: 17000,
  repetitionCharThreshold: 50000,
  syspromptAuditCharThreshold: 100000,
  maxAntiRepetitionRules: 80,
  antiRepArchiveAfter: 5,
  previewEnabled: false,
  disabledEntryIds: ["entry-a", "entry-b"],
  playerCharacterKeys: ["James", "Marcus"],
  coldInflationWeightMultiplier: 0.6,
  fastModeEnabled: false,
};

// Expected SQLite json_type() for every dial, keyed by the name as it appears
// in stored JSON. Both current and legacy validator names are listed so the
// fields are type-checked on both sides of the 0054 rename. Float-capable
// fields allow 'integer' too (a whole-number value, e.g. 0, is stored as one).
const EXPECTED_JSON_TYPES: Record<string, string[]> = {
  mode: ["text"],
  retrievalBudgetTokens: ["integer"],
  semanticTopK: ["integer"],
  semanticThreshold: ["real", "integer"],
  scanDepth: ["integer"],
  contextBudgetTokens: ["integer"],
  guaranteedMessageCount: ["integer"],
  embeddingModel: ["text"],
  researcherEnabled: ["true", "false"],
  researcherModel: ["text"],
  researcherMaxPicks: ["integer"],
  hydeEnabled: ["true", "false"],
  hydeModel: ["text"],
  rollingEnabled: ["true", "false"],
  rollingCadence: ["integer"],
  rollingModel: ["text"],
  sceneValidatorEnabled: ["true", "false"],
  sceneValidatorModel: ["text"],
  sceneValidatorAutoRegen: ["true", "false"],
  presenceValidatorEnabled: ["true", "false"], // legacy (pre-0054)
  presenceValidatorModel: ["text"], // legacy (pre-0054)
  presenceValidatorAutoRegen: ["true", "false"], // legacy (pre-0054)
  attireTrackingEnabled: ["true", "false"],
  attireStaleTurnThreshold: ["integer"],
  pipelineAutoEnabled: ["true", "false"],
  rollingDiffCharThreshold: ["integer"],
  repetitionCharThreshold: ["integer"],
  syspromptAuditCharThreshold: ["integer"],
  maxAntiRepetitionRules: ["integer"],
  antiRepArchiveAfter: ["integer"],
  previewEnabled: ["true", "false"],
  disabledEntryIds: ["array"],
  playerCharacterKeys: ["array"],
  coldInflationWeightMultiplier: ["real", "integer"],
  fastModeEnabled: ["true", "false"],
};

type Sqlite = ReturnType<typeof createDatabaseClient>["sqlite"];

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function tableColumns(sqlite: Sqlite, table: string): ColumnInfo[] {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function columnExists(sqlite: Sqlite, table: string, column: string): boolean {
  return tableColumns(sqlite, table).some((c) => c.name === column);
}

/**
 * Insert a row into `table`, supplying `values` for the columns we care about
 * and a type-appropriate dummy for any other NOT NULL column without a default.
 * Schema-evolution-proof: reads the live table shape via PRAGMA.
 */
function insertRow(sqlite: Sqlite, table: string, values: Record<string, unknown>) {
  const row: Record<string, unknown> = {};
  for (const col of tableColumns(sqlite, table)) {
    if (col.name in values) {
      row[col.name] = values[col.name];
    } else if (col.pk === 0 && col.dflt_value === null && col.notnull === 1) {
      const t = col.type.toUpperCase();
      row[col.name] = t.includes("INT") || t.includes("REAL") || t.includes("NUM") ? 0 : "";
    }
  }
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .run(...keys.map((k) => row[k]));
}

/** Assert every settings-JSON row is valid against the contract after `afterMigration`. */
function assertSettingsIntegrity(sqlite: Sqlite, afterMigration: string) {
  for (const [table, column] of [
    ["sessions", "context_overrides_json"],
    ["campaigns", "context_defaults_json"],
  ] as const) {
    const rows = sqlite
      .prepare(`SELECT rowid AS rowid, ${column} AS json FROM ${table} WHERE ${column} IS NOT NULL`)
      .all() as { rowid: number; json: string }[];

    for (const r of rows) {
      // 1. Still valid JSON.
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.json);
      } catch {
        throw new Error(`${table}.${column} is not valid JSON after migration ${afterMigration}: ${r.json}`);
      }

      // 2. Still parses against the ContextSettings contract — this type-checks
      //    every dial (z.boolean rejects 0/1, z.number rejects strings, z.enum
      //    rejects unknown values, etc.).
      const result = contextSettingsUpdateSchema.safeParse(parsed);
      expect(
        result.success,
        `${table}.${column} failed the ContextSettings contract after migration ${afterMigration}: ` +
          (result.success ? "" : result.error.issues.map((i) => `${i.path.join(".")} — ${i.message}`).join("; ")),
      ).toBe(true);

      // 3. Every dial that is present has its exact JSON storage type intact —
      //    catches silent coercions (boolean->integer, number->string, etc.)
      //    even for fields the contract might coerce or strip.
      for (const [field, allowed] of Object.entries(EXPECTED_JSON_TYPES)) {
        const { jsonType } = sqlite
          .prepare(`SELECT json_type(${column}, '$.' || ?) AS jsonType FROM ${table} WHERE rowid = ?`)
          .get(field, r.rowid) as { jsonType: string | null };
        if (jsonType !== null) {
          expect(
            allowed,
            `${table}.${column} dial "${field}" is json_type "${jsonType}" (expected ${allowed.join("/")}) ` +
              `after migration ${afterMigration} — a migration coerced the value's stored type`,
          ).toContain(jsonType);
        }
      }
    }
  }
}

describe("database migrations — settings JSON integrity", () => {
  it("the seed and json-type map cover every ContextSettings dial", () => {
    // Self-maintaining guard: if a new dial is added to ContextSettings without
    // being added to SEED_SETTINGS / EXPECTED_JSON_TYPES, this fails.
    for (const field of Object.keys(contextSettingsSchema.shape)) {
      const seedKey = RENAMED[field] ?? field;
      expect(SEED_SETTINGS, `SEED_SETTINGS is missing dial "${field}" — add it`).toHaveProperty(seedKey);
      expect(
        EXPECTED_JSON_TYPES,
        `EXPECTED_JSON_TYPES is missing dial "${field}" — add its json_type`,
      ).toHaveProperty(field);
    }
  });

  it("preserves every dial's value and type across every migration", () => {
    const { sqlite } = createDatabaseClient(":memory:");
    try {
      const migrations = readMigrations();
      expect(migrations.length).toBeGreaterThan(0);

      let seeded = false;
      for (const migration of migrations) {
        sqlite.exec(migration.sql);

        // Seed as soon as the settings columns exist (migration 0041), so the
        // rows flow through every subsequent migration.
        if (!seeded && columnExists(sqlite, "sessions", "context_overrides_json")) {
          const json = JSON.stringify(SEED_SETTINGS);
          insertRow(sqlite, "users", { id: "test-user" }); // parent FK row
          insertRow(sqlite, "sessions", { id: "test-session", user_id: "test-user", context_overrides_json: json });
          insertRow(sqlite, "campaigns", { id: "test-campaign", user_id: "test-user", context_defaults_json: json });
          seeded = true;
        }

        // Once seeded, re-check after every migration so a failure names the culprit.
        if (seeded) assertSettingsIntegrity(sqlite, migration.name);
      }

      expect(seeded, "no migration created sessions.context_overrides_json").toBe(true);

      // Explicit value assertions for the 0054 rename: the legacy
      // presenceValidator* dials survive as real JSON booleans/strings with
      // their seeded values.
      const session = sqlite
        .prepare("SELECT context_overrides_json AS json FROM sessions WHERE id = 'test-session'")
        .get() as { json: string };
      const final = JSON.parse(session.json) as Record<string, unknown>;
      expect(final.sceneValidatorAutoRegen, "sceneValidatorAutoRegen lost its value through the 0054 rename").toBe(false);
      expect(final.sceneValidatorEnabled).toBe(true);
      expect(final.sceneValidatorModel).toBe("claude-haiku-4-5-bridge");
      expect(final.presenceValidatorAutoRegen, "legacy presenceValidator* keys should be removed by 0054").toBeUndefined();
      expect(final.presenceValidatorEnabled).toBeUndefined();
      expect(final.presenceValidatorModel).toBeUndefined();

      // Spot-check a representative dial of each remaining type survived intact.
      expect(final.mode).toBe("hybrid");
      expect(final.retrievalBudgetTokens).toBe(4000);
      expect(final.coldInflationWeightMultiplier).toBe(0.6);
      expect(final.previewEnabled).toBe(false);
      expect(final.playerCharacterKeys).toEqual(["James", "Marcus"]);
    } finally {
      sqlite.close();
    }
  });
});
