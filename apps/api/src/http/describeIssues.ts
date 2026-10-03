/** Name the fields a rejected request body got wrong, at most five, as "path: message" pairs
 *  joined by "; " (first for the lorebook routes): a bare "invalid …" left Android, which
 *  shows the server's message, with no way to tell which field failed. Shared by the lorebook
 *  and drives controllers and, since 2026-09-30, the campaign create, update and restore
 *  routes and the world tick and apply routes.
 *  `formatPath` lets a route name a path its own way (the world apply names the event);
 *  by default the path is dot-joined, "body" when empty. */
export function describeIssues(
  error: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> },
  formatPath: (path: ReadonlyArray<string | number>) => string = (path) => path.join(".") || "body",
): string {
  const issues = error.issues.slice(0, 5).map((issue) => `${formatPath(issue.path)}: ${issue.message}`);
  const more = error.issues.length > 5 ? `; ${error.issues.length - 5} more` : "";
  return `${issues.join("; ")}${more}`;
}
