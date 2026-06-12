import type { IncomingHttpHeaders } from "node:http";

/** Pick the first string value from a possibly-multi-valued request header. */
export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Pick the first string from req.query when the value may be a string[]. */
export type { IncomingHttpHeaders };
