import { useEffect } from "react";

import { useCodingBackend } from "./backend";

const SHORTCUTS: Array<[string, string]> = [
  ["Enter", "Send message"],
  ["Shift+Enter", "Newline"],
  ["Shift+Tab", "Cycle permission mode (research ⇄ execute)"],
  ["Esc", "Interrupt the in-flight turn"],
  ["/", "Slash-command menu"],
  ["@", "Reference a file"],
  ["↑ / ↓", "Recall prompt history"],
  ["⌘K", "Command palette / session switcher"],
  ["⌘/", "Toggle session rail"],
];

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  // The panel hotkey differs per backend (⌘⇧C Claude / ⌘⇧K Kimi).
  const { title, hotkeyLabel } = useCodingBackend();
  const shortcuts: Array<[string, string]> = [...SHORTCUTS, [hotkeyLabel, `Toggle ${title} full-screen`]];
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="ccp-overlay-backdrop" onClick={onClose}>
      <div className="ccp-shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="ccp-shortcuts-head">Keyboard shortcuts</div>
        <table className="ccp-shortcuts-table">
          <tbody>
            {shortcuts.map(([k, d]) => (
              <tr key={k}><td className="ccp-shortcuts-key"><kbd>{k}</kbd></td><td>{d}</td></tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="ccp-shortcuts-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
