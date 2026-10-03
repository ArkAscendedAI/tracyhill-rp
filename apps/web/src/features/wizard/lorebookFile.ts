// What the import dialog shows about a chosen SillyTavern lorebook before it is sent.
// The server parses the file again with the lorebook importer; this is only the preview.

export type LorebookFileSummary = {
  entries: number;
  // The entries' titles, offered when the owner names the player character or {{char}}.
  titles: string[];
  // The file uses {{char}}: the dialog asks what it stands for.
  usesChar: boolean;
  // A name the file itself carries (a character card's book), for the campaign name's placeholder.
  bookName: string | null;
};

type Book = { entries?: unknown; name?: unknown };

// The names exporters give a book by default, which say nothing about the world ("Exported" from a SillyTavern export).
const GENERIC_BOOK_NAMES = /^(?:exported|world ?info|lorebook|untitled|new world|default)$/i;

/** The book inside a World Info file, a character card (V2/V3) or this app's own export; null when there is none. */
export function findLorebook(json: unknown): Book | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown> & { data?: Record<string, unknown> & { character_book?: Book }; character_book?: Book; originalData?: Book };
  const candidates: unknown[] = [root, root.originalData, root.data, root.data?.character_book, root.character_book];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && (candidate as Book).entries && typeof (candidate as Book).entries === "object") return candidate as Book;
  }
  return null;
}

export function summarizeLorebookFile(json: unknown, text: string): LorebookFileSummary | null {
  const book = findLorebook(json);
  if (!book) return null;
  const raw = Array.isArray(book.entries) ? book.entries : Object.values(book.entries as Record<string, unknown>);
  const entries = raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
  const titles = [...new Set(entries
    .map((entry) => (typeof entry.comment === "string" && entry.comment.trim() ? entry.comment : typeof entry.name === "string" ? entry.name : ""))
    .map((title) => title.trim())
    .filter((title) => title.length > 0 && title.length <= 80))];
  return {
    entries: entries.length,
    titles: titles.slice(0, 500),
    usesChar: /\{\{\s*char\s*\}\}|<BOT>|<CHAR>/i.test(text),
    bookName: typeof book.name === "string" && book.name.trim() && !GENERIC_BOOK_NAMES.test(book.name.trim()) ? book.name.trim() : null,
  };
}

/** A campaign name from a file name: "dark_forest-lorebook.json" → "Dark Forest". */
export function campaignNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\b(lorebook|world ?info|worldinfo)\b/gi, "").replace(/\s+/g, " ").trim();
  return base.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * About how many model calls the conversion makes: sorting in batches of up to forty entries, preparing characters a
 * few at a time (most lorebooks are about a third characters), the rule entries, and the system prompt.
 */
export function estimateImportCalls(entries: number): number {
  return Math.ceil(entries / 40) + Math.ceil(entries / 3 / 4) + 2;
}
