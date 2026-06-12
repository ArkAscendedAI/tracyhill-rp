import type { ScoredCandidate } from "./budgetPruner";

export function renderRetrievedContext(candidates: ScoredCandidate[], presentCharacters: string[]): string | null {
  if (candidates.length === 0) return null;

  const sceneKnowledge: ScoredCandidate[] = [];
  const narratorOnly: ScoredCandidate[] = [];

  for (const c of candidates) {
    const knownBy: string[] | null = c.entry.knownBy ?? null;
    if (!knownBy || knownBy.length === 0 || presentCharacters.length === 0) {
      sceneKnowledge.push(c);
    } else {
      const hasKnowerPresent = knownBy.some(k => presentCharacters.some(p => p.toLowerCase() === k.toLowerCase()));
      (hasKnowerPresent ? sceneKnowledge : narratorOnly).push(c);
    }
  }

  const sections: string[] = [];

  if (sceneKnowledge.length > 0) {
    sections.push("# Scene Knowledge\n");
    sections.push("The following is established canon known by characters currently present. Use freely in dialogue and reactions.\n");
    for (const c of sortByTagAndOrder(sceneKnowledge)) {
      const suffix = c.entry.tag && c.entry.tag !== "general" ? ` (${c.entry.tag})` : "";
      sections.push(`## ${c.entry.name}${suffix}`);
      sections.push(c.entry.content);
      sections.push("");
    }
  }

  if (narratorOnly.length > 0) {
    sections.push("# Narrator-Only Knowledge\n");
    sections.push("You need this to write the scene accurately, but characters NOT listed in KNOWN BY must not reference, react to, or hint at this information.\n");
    for (const c of sortByTagAndOrder(narratorOnly)) {
      const knownBy: string[] = c.entry.knownBy!;
      const notKnown = presentCharacters.filter(p => !knownBy.some(k => k.toLowerCase() === p.toLowerCase()));
      const suffix = c.entry.tag && c.entry.tag !== "general" ? ` (${c.entry.tag})` : "";
      sections.push(`## ${c.entry.name}${suffix}`);
      sections.push(`**KNOWN BY:** ${knownBy.join(", ")} · **NOT KNOWN BY PRESENT:** ${notKnown.join(", ")}`);
      sections.push(c.entry.content);
      sections.push("");
    }
  }

  return sections.length > 0 ? sections.join("\n").trim() : null;
}

function sortByTagAndOrder(candidates: ScoredCandidate[]): ScoredCandidate[] {
  return [...candidates].sort((a, b) => {
    const tagA = a.entry.tag || "general";
    const tagB = b.entry.tag || "general";
    if (tagA !== tagB) return tagA.localeCompare(tagB);
    return a.entry.insertionOrder - b.entry.insertionOrder;
  });
}
