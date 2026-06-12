import { describe, expect, it } from "vitest";

import { parseSceneBlock } from "./sceneParser";

describe("sceneParser ATTIRE field", () => {
  it("parses ATTIRE from a multi-line [SCENE] block (indented entries)", () => {
    const content = `[SCENE]\nlocation: smithy\npresent: Cob, Ragen\ndate: Monday, September 28\ntime: 10:47 AM\nATTIRE:\n  Cob: linen tunic, leather trousers, scuffed boots\n  Ragen: blacksmith apron over linen shirt, breeches, work boots\n[/SCENE]\n\nThe forge roared.`;
    const { sceneState, cleanContent } = parseSceneBlock(content);
    expect(sceneState).not.toBeNull();
    expect(sceneState!.location).toBe("smithy");
    expect(sceneState!.attire).toEqual({
      Cob: "linen tunic, leather trousers, scuffed boots",
      Ragen: "blacksmith apron over linen shirt, breeches, work boots",
    });
    expect(cleanContent).toBe("The forge roared.");
  });

  it("parses ATTIRE single-line semicolon-separated form in a [SCENE] block", () => {
    const content = `[SCENE]\nlocation: tavern\npresent: Mery\nATTIRE: Mery=stained wool dress, leather apron, wooden clogs\n[/SCENE]\n\nShe wiped the bar.`;
    const { sceneState } = parseSceneBlock(content);
    expect(sceneState!.attire).toEqual({ Mery: "stained wool dress, leather apron, wooden clogs" });
  });

  it("parses ATTIRE from an <scene_state> XML tag (pipe-delimited)", () => {
    const content = `<scene_state>SCENE: smithy | PRESENT: Cob, Ragen | ATTIRE: Cob=linen tunic; Ragen=apron</scene_state>\n\nThe fire crackled.`;
    const { sceneState } = parseSceneBlock(content);
    expect(sceneState).not.toBeNull();
    expect(sceneState!.attire).toEqual({ Cob: "linen tunic", Ragen: "apron" });
  });

  it("treats ATTIRE as optional — block without ATTIRE returns null attire", () => {
    const content = `[SCENE]\nlocation: temple\npresent: Bruna\n[/SCENE]\n\nSilence settled.`;
    const { sceneState } = parseSceneBlock(content);
    expect(sceneState!.attire).toBeNull();
  });

  it("does not crash on malformed ATTIRE content (missing separator)", () => {
    const content = `[SCENE]\nlocation: hall\npresent: Elissa\nATTIRE:\n  just rambling text without name equals outfit\n[/SCENE]\n\nShe paced.`;
    const { sceneState } = parseSceneBlock(content);
    expect(sceneState).not.toBeNull();
    expect(sceneState!.attire).toBeNull();
  });

  it("stops ATTIRE block at next top-level field", () => {
    const content = `[SCENE]\nlocation: keep\npresent: Tender Ronnell\nATTIRE:\n  Tender Ronnell: chain mail over gambeson, helm under arm\ndate: Friday\ntime: dawn\n[/SCENE]\n\nDawn broke.`;
    const { sceneState } = parseSceneBlock(content);
    expect(sceneState!.attire).toEqual({ "Tender Ronnell": "chain mail over gambeson, helm under arm" });
    expect(sceneState!.date).toBe("Friday");
    expect(sceneState!.time).toBe("dawn");
  });
});
