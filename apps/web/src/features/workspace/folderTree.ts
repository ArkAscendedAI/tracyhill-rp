import type { Folder } from "@tracyhill-rp/contracts";

export const MAX_FOLDER_DEPTH = 4;

export type FolderTreeNode = {
  folder: Folder;
  children: FolderTreeNode[];
};

export type FolderOption = {
  id: string;
  label: string;
  depth: number;
};

export function buildFolderTree(folders: Folder[]) {
  const sorted = sortFolders(folders);
  const ids = new Set(sorted.map((folder) => folder.id));
  const byParent = new Map<string | null, Folder[]>();
  for (const folder of sorted) {
    const parentId = folder.parentId && ids.has(folder.parentId) ? folder.parentId : null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(folder);
    byParent.set(parentId, siblings);
  }
  // Every folder is placed once. A parent cycle (a ↔ b — the API refuses to
  // create one, so it takes a direct edit or a damaged restore) used to give
  // its members no root at all: they and their sessions silently vanished
  // from the sidebar. Such folders now surface as roots so they can be
  // repaired in place, and the recursion is bounded.
  const placed = new Set<string>();
  const build = (parentId: string | null): FolderTreeNode[] => (byParent.get(parentId) ?? [])
    .filter((folder) => !placed.has(folder.id))
    .map((folder) => {
      placed.add(folder.id);
      return { folder, children: build(folder.id) };
    });
  const tree = build(null);
  for (const folder of sorted) {
    if (placed.has(folder.id)) continue;
    placed.add(folder.id);
    tree.push({ folder, children: build(folder.id) });
  }
  return tree;
}

export function collectDescendantFolderIds(folders: Folder[], folderId: string) {
  const ids = [folderId];
  // Visited set: the siblings getFolderDepth/getFolderPathLabel cap their
  // walks, but this BFS pushed the members of a parent cycle forever until the
  // array threw and the app-level ErrorBoundary replaced the shell.
  const seen = new Set(ids);
  const queue = [folderId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of folders) {
      if (child.parentId !== current || seen.has(child.id)) continue;
      seen.add(child.id);
      ids.push(child.id);
      queue.push(child.id);
    }
  }
  return ids;
}

export function getFolderDepth(folders: Folder[], folderId: string) {
  const sorted = sortFolders(folders);
  let depth = 0;
  let currentId: string | null = folderId;
  while (currentId && depth < 32) {
    const current = sorted.find((folder) => folder.id === currentId);
    if (!current) break;
    currentId = current.parentId;
    depth += 1;
  }
  return depth;
}

export function flattenFolderOptions(folders: Folder[], options?: { excludeIds?: Iterable<string> }) {
  const excluded = new Set(options?.excludeIds ?? []);
  const items: FolderOption[] = [];
  const visit = (nodes: FolderTreeNode[], depth: number) => {
    for (const node of nodes) {
      if (!excluded.has(node.folder.id)) {
        items.push({
          id: node.folder.id,
          label: `${depth ? ".. ".repeat(depth) : ""}${node.folder.name}`,
          depth,
        });
      }
      visit(node.children, depth + 1);
    }
  };
  visit(buildFolderTree(folders), 0);
  return items;
}

export function getFolderPathLabel(folders: Folder[], folderId: string | null | undefined) {
  if (!folderId) return null;
  const sorted = sortFolders(folders);
  const parts: string[] = [];
  let currentId: string | null = folderId;
  let guard = 0;
  while (currentId && guard < 32) {
    const current = sorted.find((folder) => folder.id === currentId);
    if (!current) break;
    parts.unshift(current.name);
    currentId = current.parentId;
    guard += 1;
  }
  return parts.length ? parts.join(" / ") : null;
}

function sortFolders(folders: Folder[]) {
  return [...folders].sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
}
