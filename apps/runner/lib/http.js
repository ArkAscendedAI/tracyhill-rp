import { timingSafeEqual } from "node:crypto";

export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        reject(httpError(413, "Request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(httpError(400, "Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

// Constant-time bearer compare; length first because timingSafeEqual throws on
// unequal buffers (leaking the length is harmless, the bytes are not).
export function bearerMatches(header, secret) {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(String(header ?? ""), "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
