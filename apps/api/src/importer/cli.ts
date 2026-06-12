import path from "node:path";
import process from "node:process";

import { runV1Import } from "./v1Importer";

function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let dryRun = false;
  let report = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--report") {
      report = true;
      continue;
    }
    if (!token.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${token}`);
    values.set(token.slice(2), next);
    index += 1;
  }
  if (dryRun && report) throw new Error("--dry-run and --report cannot be combined");
  const sourceDir = values.get("source");
  if (!sourceDir) throw new Error("--source is required");
  const result = runV1Import({
    sourceDir: path.resolve(sourceDir),
    dbFile: values.get("db-file") ? path.resolve(values.get("db-file")!) : undefined,
    imageDir: values.get("image-dir") ? path.resolve(values.get("image-dir")!) : undefined,
    dryRun,
    report,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "import failed"}\n`);
  process.exitCode = 1;
}
