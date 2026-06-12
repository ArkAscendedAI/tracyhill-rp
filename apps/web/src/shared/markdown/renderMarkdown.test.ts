import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./renderMarkdown";

describe("renderMarkdown — GFM tables", () => {
  it("renders a basic pipe table with thead and tbody", () => {
    const html = renderMarkdown("| Name | Role |\n| --- | --- |\n| Buffy | Slayer |\n| Giles | Watcher |");
    expect(html).toContain('<div class="md-table-wrap"><table class="md-table">');
    expect(html).toContain("<thead><tr><th>Name</th><th>Role</th></tr></thead>");
    expect(html).toContain("<td>Buffy</td><td>Slayer</td>");
    expect(html).toContain("<td>Giles</td><td>Watcher</td>");
  });

  it("works without leading/trailing pipes", () => {
    const html = renderMarkdown("a | b\n--- | ---\n1 | 2");
    expect(html).toContain("<th>a</th><th>b</th>");
    expect(html).toContain("<td>1</td><td>2</td>");
  });

  it("applies alignment classes from the delimiter row", () => {
    const html = renderMarkdown("| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |");
    expect(html).toContain('<th class="md-al">L</th>');
    expect(html).toContain('<th class="md-ac">C</th>');
    expect(html).toContain('<th class="md-ar">R</th>');
    expect(html).toContain('<td class="md-ar">c</td>');
  });

  it("preserves escaped pipes as literal characters in cells", () => {
    const html = renderMarkdown("| Cmd | Desc |\n| --- | --- |\n| a \\| b | pipe |");
    expect(html).toContain("<td>a | b</td>");
  });

  it("renders inline formatting inside cells", () => {
    const html = renderMarkdown("| A | B |\n| --- | --- |\n| **bold** | `code` |");
    expect(html).toContain("<td><strong>bold</strong></td>");
    expect(html).toContain('<td><code class="ic">code</code></td>');
  });

  it("pads short rows and truncates long rows to the header width", () => {
    const html = renderMarkdown("| A | B |\n| --- | --- |\n| only |\n| 1 | 2 | 3 |");
    expect(html).toContain("<td>only</td><td></td>");
    expect(html).toContain("<td>1</td><td>2</td></tr>");
    expect(html).not.toContain("<td>3</td>");
  });

  it("terminates at a blank line and resumes normal parsing", () => {
    const html = renderMarkdown("| A |\n| --- |\n| 1 |\n\nafter table");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<p>after table</p>");
  });

  it("does NOT create a table from prose containing a pipe", () => {
    const html = renderMarkdown('she said "wait" | he replied "no"\nand the scene continued');
    expect(html).not.toContain("<table");
  });

  it("does NOT create a table without a delimiter row", () => {
    const html = renderMarkdown("| a | b |\n| c | d |");
    expect(html).not.toContain("<table");
  });

  it("requires matching column counts between header and delimiter", () => {
    const html = renderMarkdown("| a | b | c |\n| --- | --- |\n| 1 | 2 |");
    expect(html).not.toContain("<table");
  });

  it("leaves pipes inside fenced code blocks alone", () => {
    const html = renderMarkdown("```\n| a | b |\n| --- | --- |\n```");
    expect(html).not.toContain("<table");
    expect(html).toContain("cb-wrap");
  });

  it("renders a header-only table (no body rows)", () => {
    const html = renderMarkdown("| A | B |\n| --- | --- |");
    expect(html).toContain("<thead><tr><th>A</th><th>B</th></tr></thead>");
    expect(html).not.toContain("<tbody>");
  });
});

describe("renderMarkdown — regressions (existing behavior)", () => {
  it("renders headings, lists, blockquotes, hr", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two\n\n> quoted\n\n---");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<blockquote>quoted</blockquote>");
    expect(html).toContain("<hr>");
  });

  it("a plain --- line stays an hr, not a table delimiter", () => {
    const html = renderMarkdown("some text\n---");
    expect(html).toContain("<hr>");
    expect(html).not.toContain("<table");
  });

  it("wraps curly-quoted dialog in dlg spans", () => {
    const html = renderMarkdown("“Hello there”");
    expect(html).toContain("class='dlg'");
  });

  it("renders fenced code with language header", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    expect(html).toContain('<span class="cb-lang">js</span>');
  });

  it("renders inline code without applying bold inside it", () => {
    const html = renderMarkdown("`**not bold**`");
    expect(html).toContain('<code class="ic">**not bold**</code>');
    expect(html).not.toContain("<strong>");
  });

  it("renders ordered lists", () => {
    const html = renderMarkdown("1. first\n2. second");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  });
});
