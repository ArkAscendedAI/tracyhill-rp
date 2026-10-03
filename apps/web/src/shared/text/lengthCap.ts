/**
 * The sentence for a text over its contract's length limit, named before it is sent: the
 * server answers such a request with a bare "invalid … request" 400. Numbers are grouped as the web prints counts.
 */
export function overLimitMessage(label: string, length: number, max: number): string {
  return `${label} is ${length.toLocaleString("en-US")} characters; the limit is ${max.toLocaleString("en-US")}.`;
}
