import { afterEach, describe, expect, it, vi } from "vitest";

import { EmbeddingService, GoogleEmbeddingProvider } from "./embeddingService";
import type { EmbeddingProvider, EmbeddingTask } from "./embeddingService";
import type { LorebookEmbeddingRepository } from "./lorebookEmbeddingRepository";

function fakeResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("GoogleEmbeddingProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureBody(embeddings: { values: number[] }[]) {
    const captured: { body?: any } = {};
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      captured.body = JSON.parse(init.body);
      return fakeResponse({ embeddings });
    });
    return captured;
  }

  it("sends RETRIEVAL_QUERY + outputDimensionality for query embeds", async () => {
    const captured = captureBody([{ values: [0.1, 0.2, 0.3] }]);
    await new GoogleEmbeddingProvider("k").embed(["hello"], "google:gemini-embedding-2", "query");
    expect(captured.body.requests[0].taskType).toBe("RETRIEVAL_QUERY");
    expect(captured.body.requests[0].outputDimensionality).toBe(3072);
  });

  it("sends RETRIEVAL_DOCUMENT for document embeds", async () => {
    const captured = captureBody([{ values: [0.1] }]);
    await new GoogleEmbeddingProvider("k").embed(["doc"], "google:gemini-embedding-2", "document");
    expect(captured.body.requests[0].taskType).toBe("RETRIEVAL_DOCUMENT");
  });

  it("omits taskType when no task is given", async () => {
    const captured = captureBody([{ values: [0.1] }]);
    await new GoogleEmbeddingProvider("k").embed(["x"], "google:gemini-embedding-2");
    expect(captured.body.requests[0].taskType).toBeUndefined();
    expect(captured.body.requests[0].outputDimensionality).toBe(3072);
  });
});

describe("EmbeddingService task threading", () => {
  class TaskSpyProvider implements EmbeddingProvider {
    public tasks: (EmbeddingTask | undefined)[] = [];
    async embed(texts: string[], _model: string, task?: EmbeddingTask) {
      this.tasks.push(task);
      return texts.map(() => [0.1, 0.2, 0.3]);
    }
    dimensions() {
      return 3;
    }
  }

  function makeService(provider: EmbeddingProvider) {
    const repo = { upsert: () => {} } as unknown as LorebookEmbeddingRepository;
    return new EmbeddingService(repo, new Map([["google", provider]]));
  }

  it("threads the query task on embedQuery", async () => {
    const provider = new TaskSpyProvider();
    await makeService(provider).embedQuery("hi", "google:gemini-embedding-2");
    expect(provider.tasks).toEqual(["query"]);
  });

  it("threads the document task on indexEntries", async () => {
    const provider = new TaskSpyProvider();
    const count = await makeService(provider).indexEntries(
      [{ id: "e1", userId: "u1", content: "body" }],
      "google:gemini-embedding-2",
    );
    expect(count).toBe(1);
    expect(provider.tasks).toEqual(["document"]);
  });
});
