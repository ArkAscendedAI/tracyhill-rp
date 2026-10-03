import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import type { ClaudeCodeEffort, KimiServingMode } from "@tracyhill-rp/contracts";

// A "coding backend" is one agent-service behind the shared panel UI. The
// panel is identical for every backend; only the wire target, the session
// cache key, and a couple of capabilities differ. Claude Code and Kimi K3 are
// both Claude-Code-harness services, so they share this whole feature dir —
// the descriptor is the ONLY thing that varies between them.
export type CodingBackend = {
  id: "claude" | "kimi";
  title: string;
  apiBase: string;              // e.g. "/api/claude-code" | "/api/kimi-code"
  sessionsKey: string;          // React Query key root — must be distinct per backend
  storagePrefix: string;        // localStorage namespace so prefs don't collide
  models: { id: string; label: string }[] | null; // null → model is fixed by the backend
  defaultModel: string;
  defaultEffort: ClaudeCodeEffort;
  // The effort ladder this backend honours; the picker offers exactly these
  // and a stored value outside them is normalized visibly.
  efforts: ClaudeCodeEffort[];
  serving: boolean;             // true → expose the API⇄Subscription serving swap (Kimi)
  // false → /compact is hidden from the slash popup and refused by the handler
  // (Moonshot's positional tool ids make compaction an id-collision loop —
  // the kimi endpoint runs with compaction DISABLED).
  supportsCompact: boolean;
  hotkeyLabel: string;          // the AppShell binding that opens this panel (shortcut table)
};

export const CLAUDE_BACKEND: CodingBackend = {
  id: "claude",
  title: "Claude Code",
  apiBase: "/api/claude-code",
  sessionsKey: "claude-code-sessions",
  storagePrefix: "cc",
  models: [
    { id: "claude-fable-5-1", label: "Fable 5.1" },
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-opus-4-7", label: "Opus 4.7" },
    { id: "claude-opus-4-6", label: "Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
  defaultModel: "claude-opus-4-8",
  defaultEffort: "max",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  serving: false,
  supportsCompact: true,
  hotkeyLabel: "⌘⇧C",
};

export const KIMI_BACKEND: CodingBackend = {
  id: "kimi",
  title: "Kimi Code (K3)",
  apiBase: "/api/kimi-code",
  sessionsKey: "kimi-code-sessions",
  storagePrefix: "kimi",
  // The wire model is fixed by the serving mode (kimi-k3 / k3), so no model
  // picker — the serving swap replaces it.
  models: null,
  defaultModel: "kimi-k3",
  defaultEffort: "max",
  // K3's ladder is low|high|max. The picker used to offer medium/xhigh too and
  // the endpoint folded them silently; now only the honoured values are offered
  // and the footer shows what runs.
  efforts: ["low", "high", "max"],
  serving: true,
  supportsCompact: false,
  hotkeyLabel: "⌘⇧K",
};

// Default = Claude, so every existing consumer that renders without a provider
// keeps its exact current behavior. The Kimi page wraps its subtree in a
// provider carrying KIMI_BACKEND.
const CodingBackendContext = createContext<CodingBackend>(CLAUDE_BACKEND);

export function CodingBackendProvider({ backend, children }: { backend: CodingBackend; children: ReactNode }) {
  return <CodingBackendContext.Provider value={backend}>{children}</CodingBackendContext.Provider>;
}

export function useCodingBackend(): CodingBackend {
  return useContext(CodingBackendContext);
}

// Kimi serving labels for the composer/status UI.
export const KIMI_SERVING_LABELS: Record<KimiServingMode, string> = {
  api: "API",
  subscription: "Subscription",
};
