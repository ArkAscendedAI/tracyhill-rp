// The chars/3.5 lorebook token estimate is defined once in @tracyhill-rp/contracts
// so the API, the workers and the web cannot drift apart. This module keeps its
// historical export name for its many importers.
export { estimateLorebookTokens as estimateTokens } from "@tracyhill-rp/contracts";
