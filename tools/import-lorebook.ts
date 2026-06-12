#!/usr/bin/env -S node --import tsx
import fs from "node:fs";
import path from "node:path";

import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";

import { LorebookRepository } from "../apps/api/src/domain/context/lorebookRepository";
import { importSillyTavernLorebook } from "../apps/api/src/domain/context/lorebookImporter";

const args = process.argv.slice(2);
const campaignIdx = args.indexOf("--campaign");
const fileIdx = args.indexOf("--file");
const userIdx = args.indexOf("--user");
const dbIdx = args.indexOf("--db");

if (campaignIdx === -1 || fileIdx === -1) {
  console.error("Usage: import-lorebook --campaign <id> --file <path.json> [--user <userId>] [--db <path>]");
  process.exit(1);
}

const campaignId = args[campaignIdx + 1]!;
const filePath = args[fileIdx + 1]!;
const userId = userIdx !== -1 ? args[userIdx + 1]! : "admin";
const dbPath = dbIdx !== -1 ? args[dbIdx + 1]! : path.resolve(process.cwd(), "data/dev/db.sqlite");

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

console.log(`Importing SillyTavern lorebook`);
console.log(`  File:     ${filePath}`);
console.log(`  Campaign: ${campaignId}`);
console.log(`  User:     ${userId}`);
console.log(`  DB:       ${dbPath}`);

migrateDatabase(dbPath);
const { db } = createDatabaseClient(dbPath);
const repo = new LorebookRepository(db);

const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
const result = importSillyTavernLorebook(repo, userId, campaignId, raw);

console.log(`\nResult:`);
console.log(`  Imported: ${result.imported}`);
console.log(`  Skipped:  ${result.skipped}`);
if (result.errors.length > 0) {
  console.log(`  Errors:`);
  for (const err of result.errors) console.log(`    - ${err}`);
}
console.log("\nDone.");
