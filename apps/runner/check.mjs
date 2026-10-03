// Syntax check every module (the runner is plain ESM JavaScript, like the Codex sidecar).
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const files = [];
const walk = (dir) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); } else if (p.endsWith(".js") || p.endsWith(".mjs")) files.push(p); } };
walk(new URL(".", import.meta.url).pathname);
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`runner: ${files.length} files parse`);
