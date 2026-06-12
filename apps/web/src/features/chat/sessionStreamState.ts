import type { ContextPreviewEntry, ContextAssemblyDebug } from "@tracyhill-rp/contracts";

export type ComposerAttachmentInput = {
  filename: string;
  mimeType: string;
  contentMode: "text" | "base64";
  content: string;
};

export type SessionStreamState = {
  sending: boolean;
  requestId: string | null;
  stopRequested: boolean;
  // True once the server reports the upstream model request has started
  // (response.started). Before that, the gap is context assembly (retrieval /
  // researcher / HyDE); after it, the gap is model ingestion. The waiting
  // indicator uses this to tell the user which phase they're in.
  responseStarted: boolean;
  pendingPrompt: string;
  pendingAttachments: ComposerAttachmentInput[];
  streamingText: string;
  streamingThinking: string;
  error: string;
  contextPreview: ContextPreviewEntry[];
  contextDebug: ContextAssemblyDebug | null;
  contextBudgetTokens: number;
  // Degradation warnings from the server (e.g. "semantic retrieval failed —
  // keyword-only this turn"). Rendered in the context preview surface so
  // passive failures are never silent.
  contextNotes: string[];
  // True once response.completed arrived: the reply is persisted server-side
  // even though the stream stays open while the scene validator runs. The UI
  // unlocks the composer at this point instead of holding it hostage for the
  // validator's full runtime.
  completed: boolean;
  completedMessageId: string | null;
};

export function createEmptySessionStreamState(): SessionStreamState {
  return {
    sending: false,
    requestId: null,
    stopRequested: false,
    responseStarted: false,
    pendingPrompt: "",
    pendingAttachments: [],
    streamingText: "",
    streamingThinking: "",
    error: "",
    contextPreview: [],
    contextDebug: null,
    contextBudgetTokens: 0,
    contextNotes: [],
    completed: false,
    completedMessageId: null,
  };
}
