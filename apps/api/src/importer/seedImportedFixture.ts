import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

import { createDatabaseClient, users } from "@tracyhill-rp/db";
import { createV1ImportProductionFixture } from "@tracyhill-rp/test-fixtures";

import { runV1Import } from "./v1Importer";

function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${token}`);
    values.set(token.slice(2), next);
    index += 1;
  }
  const dbFile = values.get("db-file");
  const imageDir = values.get("image-dir");
  if (!dbFile || !imageDir) throw new Error("--db-file and --image-dir are required");
  const password = values.get("password")?.trim() || "import-pass";
  const rootDir = values.get("root-dir")
    ? path.resolve(values.get("root-dir")!)
    : fs.mkdtempSync(path.join(os.tmpdir(), "trp-v1-imported-fixture-"));
  const fixture = createV1ImportProductionFixture(rootDir);
  runV1Import({
    sourceDir: fixture.sourceDir,
    dbFile: path.resolve(dbFile),
    imageDir: path.resolve(imageDir),
  });

  const seeded = createDatabaseClient(path.resolve(dbFile));
  try {
    seeded.db.update(users).set({
      passwordHash: bcrypt.hashSync(password, 10),
      email: null,
      emailVerified: 0,
    }).where(eq(users.id, fixture.userId)).run();
  } finally {
    seeded.sqlite.close();
  }

  process.stdout.write(`${JSON.stringify({
    sourceDir: fixture.sourceDir,
    username: "legacy-admin",
    password,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "fixture import failed"}\n`);
  process.exitCode = 1;
}
