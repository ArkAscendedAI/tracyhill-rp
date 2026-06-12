import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../app/createApp";
import { createSeededTestDb } from "../../test/testDb";

const cleanups: Array<() => void> = [];

afterEach(() => {
  delete process.env.DB_FILE;
  delete process.env.IMAGE_DIR;
  delete process.env.SESSION_SECRET;
  delete process.env.WEB_DIST_DIR;
  while (cleanups.length) cleanups.pop()?.();
});

describe("system routes", () => {
  it("returns health", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const { app } = createApp();
    const res = await request(app).get("/api/system/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe("tracyhill-rp-v2-api");
  });

  it("serves built web assets for non-api routes when a dist directory exists", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const webDist = fs.mkdtempSync(path.join(os.tmpdir(), "trp-web-dist-"));
    cleanups.push(() => fs.rmSync(webDist, { recursive: true, force: true }));
    fs.writeFileSync(path.join(webDist, "index.html"), "<!doctype html><html><body>v2 shell</body></html>");
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.WEB_DIST_DIR = webDist;
    const { app } = createApp();
    const res = await request(app).get("/campaigns/imported");
    expect(res.status).toBe(200);
    expect(res.text).toContain("v2 shell");
  });
});
