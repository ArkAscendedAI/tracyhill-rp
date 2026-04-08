import bcrypt from "bcryptjs";
import crypto from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const USERS_FILE = join(DATA_DIR, "users.json");
const USERS_DIR = join(DATA_DIR, "users");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(USERS_DIR)) mkdirSync(USERS_DIR, { recursive: true });

function loadUsers() {
  if (existsSync(USERS_FILE)) { try { return JSON.parse(readFileSync(USERS_FILE, "utf8")); } catch {} }
  return [];
}
function saveUsers(users) { writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 }); }

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

(async () => {
  const users = loadUsers();
  console.log(`\nTracyHill RP — User Management`);
  console.log(`Current users: ${users.length}`);
  if (users.length > 0) {
    console.log("Existing users:");
    users.forEach((u, i) => console.log(`  ${i + 1}. ${u.username} (${u.role})`));
  }

  const action = users.length === 0 ? "create" : (await ask("\n[c]reate new user or [r]eset password? ")).trim().toLowerCase();

  if (action === "c" || action === "create" || users.length === 0) {
    const username = (await ask("Username: ")).trim();
    if (!username || username.length < 2) { console.log("Username must be at least 2 characters"); process.exit(1); }
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) { console.log("Username already exists"); process.exit(1); }

    const password = (await ask("Password (min 8 chars): ")).trim();
    if (password.length < 8) { console.log("Password too short"); process.exit(1); }

    const role = users.length === 0 ? "admin" : (await ask("Role [admin/user] (default: user): ")).trim().toLowerCase() || "user";
    if (!["admin", "user"].includes(role)) { console.log("Invalid role"); process.exit(1); }

    const id = crypto.randomBytes(8).toString("hex");
    const passwordHash = await bcrypt.hash(password, 12);
    users.push({ id, username, role, passwordHash, createdAt: Date.now() });
    saveUsers(users);

    const userDir = join(USERS_DIR, id);
    if (!existsSync(userDir)) mkdirSync(userDir, { recursive: true });

    console.log(`\n✓ Created ${role} user "${username}" (id: ${id})`);
    if (users.length === 1) console.log("This is the first user and has been set as admin.");
  } else if (action === "r" || action === "reset") {
    const username = (await ask("Username to reset: ")).trim();
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) { console.log("User not found"); process.exit(1); }

    const password = (await ask("New password (min 8 chars): ")).trim();
    if (password.length < 8) { console.log("Password too short"); process.exit(1); }

    user.passwordHash = await bcrypt.hash(password, 12);
    saveUsers(users);
    console.log(`\n✓ Password reset for "${user.username}"`);
  } else {
    console.log("Unknown action");
  }

  rl.close();
})();
