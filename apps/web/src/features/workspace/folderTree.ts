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
  const byParent = new Map<string | null, Folder[]>();
  for (const folder of sorted) {
    const parentId = folder.parentId && sorted.some((candidate) => candidate.id === folder.parentId) ? folder.parentId : null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(folder);
    byParent.set(parentId, siblings);
  }
  const build = (parentId: string | null): FolderTreeNode[] => (byParent.get(parentId) ?? []).map((folder) => ({
    folder,
    children: build(folder.id),
  }));
  return build(null);
}

export function collectDescendantFolderIds(folders: Folder[], folderId: string) {
  const ids = [folderId];
  const queue = [folderId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of folders.filter((folder) => folder.parentId === current)) {
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
