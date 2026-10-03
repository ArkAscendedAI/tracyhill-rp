import { createContext, Script } from "node:vm";

// Only this fixed expression is executable code. Pattern/flags/text enter as
// primitive data; JavaScript regex syntax (including lookaround) is preserved.
// runInContext's watchdog interrupts synchronous RegExp execution independently
// of the API event loop: https://nodejs.org/docs/latest-v20.x/api/vm.html#scriptrunincontextcontextifiedobject-options
//
// Compiled regexes are cached inside the sandbox by pattern+flags (2026-09-21):
// a user regex key is compiled once and reused across the recursion passes of a
// turn and across turns, instead of once per test. `lastIndex` is reset before
// every test so a cached global/sticky regex stays stateless between calls.
const regexScript = new Script(`(() => {
  const key = "/" + pattern + "/" + flags;
  let re = cache.get(key);
  if (re === undefined) {
    if (cache.size >= 2000) cache.clear();
    re = new RegExp(pattern, flags);
    cache.set(key, re);
  }
  re.lastIndex = 0;
  return re.test(buffer);
})()`);
const PER_MATCH_MS = 10;
const PER_ASSEMBLY_MS = 100;
// One sandbox per thread. Instances carry only their own time budget and problem
// list; sharing the context is safe because every use is synchronous and sets
// pattern/flags/buffer immediately before running the script.
const sharedContext = createContext({ pattern: "", flags: "", buffer: "", cache: new Map<string, RegExp>() }, { codeGeneration: { strings: false, wasm: false } });

export class RegexBudget {
  readonly problems = new Map<string, string>();
  private remainingMs = PER_ASSEMBLY_MS;

  reject(pattern: string, flags: string, reason: string): null {
    this.problems.set(`/${pattern}/${flags}`, reason);
    return null;
  }

  test(pattern: string, flags: string, buffer: string): boolean | null {
    const key = `/${pattern}/${flags}`;
    if (this.problems.has(key)) return null;
    if (this.remainingMs < 1) return this.reject(pattern, flags, "regex time budget exhausted for this turn");
    sharedContext.pattern = pattern;
    sharedContext.flags = flags;
    sharedContext.buffer = buffer;
    const started = performance.now();
    try {
      return regexScript.runInContext(sharedContext, { timeout: Math.max(1, Math.min(PER_MATCH_MS, Math.floor(this.remainingMs))) }) === true;
    } catch (error) {
      // VM exceptions belong to a different realm, so instanceof Error is not
      // a reliable discriminator. No host callbacks or async work run here.
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      return this.reject(pattern, flags, code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? "regex exceeded its execution limit" : "invalid regex pattern or flags");
    } finally {
      this.remainingMs -= performance.now() - started;
      sharedContext.buffer = "";
    }
  }
}
