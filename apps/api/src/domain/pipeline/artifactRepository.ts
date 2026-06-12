import { randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";

import { pipelineRunArtifacts, type DatabaseClient } from "@tracyhill-rp/db";
import type { PipelineArtifactKind, PipelineRunArtifact } from "@tracyhill-rp/contracts";

// 90-day retention per schema comment. Sweep is called lazily from the API boot.
const RETENTION_DAYS = 90;

export class ArtifactRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  write(runId: string, stage: string, kind: PipelineArtifactKind, content: string) {
    const bytes = Buffer.byteLength(content, "utf8");
    this.db.insert(pipelineRunArtifacts).values({
      id: randomUUID(),
      runId,
      stage,
      kind,
      content,
      bytes,
      createdAt: new Date().toISOString(),
    }).run();
  }

  listByRun(runId: string): PipelineRunArtifact[] {
    const rows = this.db.select().from(pipelineRunArtifacts)
      .where(eq(pipelineRunArtifacts.runId, runId))
      .orderBy(desc(pipelineRunArtifacts.createdAt))
      .all();
    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      stage: r.stage,
      kind: r.kind as PipelineArtifactKind,
      content: r.content,
      bytes: r.bytes,
      createdAt: r.createdAt,
    }));
  }

  sweepExpired(now = new Date()): number {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.delete(pipelineRunArtifacts)
      .where(lt(pipelineRunArtifacts.createdAt, cutoff))
      .run();
    return result.changes ?? 0;
  }
}
