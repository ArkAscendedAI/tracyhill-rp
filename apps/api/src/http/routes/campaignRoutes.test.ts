import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { minimalUser } from "@tracyhill-rp/test-fixtures";

import { createApp } from "../../app/createApp";
import { createSeededTestDb } from "../../test/testDb";

const cleanups: Array<() => void> = [];

afterEach(() => {
  delete process.env.DB_FILE;
  delete process.env.IMAGE_DIR;
  delete process.env.SESSION_SECRET;
  while (cleanups.length) cleanups.pop()?.();
});

describe("campaign routes", () => {
  it("supports campaign CRUD, manual current-version control, and version history", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const { app } = createApp();
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const folder = await agent.post("/api/workspace/folders").send({ name: "Ashenmoor Folder" }).expect(201);
    const folderId = String(folder.body.folders[0].id);

    const initial = await agent.get("/api/campaigns").expect(200);
    expect(initial.body.campaigns).toEqual([]);

    const created = await agent.post("/api/campaigns").send({
      name: "Ashenmoor",
      folderId,
      pipelineModelId: "gemini-2.5-flash",
      systemPrompt: "You are the chronicler of Ashenmoor.",
    }).expect(201);
    expect(created.body.campaigns).toHaveLength(1);
    expect(created.body.campaigns[0].version).toBe(0);
    expect(created.body.campaigns[0].folderId).toBe(folderId);
    expect(created.body.campaigns[0].pipelineModelId).toBe("gemini-2.5-flash");
    const campaignId = String(created.body.campaigns[0].id);

    const versionOnlyUpdated = await agent.patch(`/api/campaigns/${campaignId}`).send({
      version: 6,
    }).expect(200);
    expect(versionOnlyUpdated.body.campaigns[0].version).toBe(6);

    const updated = await agent.patch(`/api/campaigns/${campaignId}`).send({
      name: "Ashenmoor Revised",
      folderId: null,
      systemPrompt: "You are the chronicler of the revised Ashenmoor.",
    }).expect(200);
    expect(updated.body.campaigns[0].name).toBe("Ashenmoor Revised");
    expect(updated.body.campaigns[0].folderId).toBeNull();
    expect(updated.body.campaigns[0].version).toBe(7);

    const manuallyVersioned = await agent.patch(`/api/campaigns/${campaignId}`).send({
      systemPrompt: "You are the chronicler of the revised Ashenmoor, with a second revision.",
      version: 11,
    }).expect(200);
    expect(manuallyVersioned.body.campaigns[0].version).toBe(11);

    const versions = await agent.get(`/api/campaigns/${campaignId}/versions`).expect(200);
    expect(versions.body.versions).toHaveLength(3);
    expect(versions.body.versions[0]).toMatchObject({ version: 11, isCurrent: true });
    expect(versions.body.versions[1]).toMatchObject({ version: 7, isCurrent: false });
    expect(versions.body.versions[2]).toMatchObject({ version: 6, isCurrent: false });

    const restored = await agent.post(`/api/campaigns/${campaignId}/versions/6/restore`).expect(200);
    // Restore brings back the CONTENT but keeps the version counter monotonic
    // (current+1): rewinding it produced duplicate unlabeled version numbers
    // on the next edit and permanently shadowed historical archives.
    expect(restored.body.campaigns[0].version).toBe(12);
    expect(restored.body.campaigns[0].systemPrompt).toBe("You are the chronicler of Ashenmoor.");

    const postRestoreVersions = await agent.get(`/api/campaigns/${campaignId}/versions`).expect(200);
    const labels = postRestoreVersions.body.versions.map((entry: { label: string | null }) => entry.label);
    const snapshotCount = labels.filter((label: string | null) => label && label.startsWith("Restored-V6-")).length;
    expect(snapshotCount).toBe(1);
    const currentEntry = postRestoreVersions.body.versions.find((entry: { isCurrent: boolean }) => entry.isCurrent);
    expect(currentEntry.version).toBe(12);
    expect(currentEntry.label).toBeNull();

    const removed = await agent.delete(`/api/campaigns/${campaignId}`).expect(200);
    expect(removed.body.campaigns).toEqual([]);
  });
});
