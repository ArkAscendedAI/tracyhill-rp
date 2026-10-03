/** Pick the first string value from a possibly-multi-valued request header. */
export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
