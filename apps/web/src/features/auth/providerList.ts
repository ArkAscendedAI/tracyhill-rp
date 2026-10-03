import type { ProviderId } from "@tracyhill-rp/contracts";

// The providers a person connects with an API key, in the order the Providers dialog and the first-run setup list them.
export const API_KEY_PROVIDERS: Array<{ id: ProviderId; label: string; detail: string }> = [
  { id: "anthropic", label: "Anthropic", detail: "Claude chat plus pipeline and wizard runs." },
  { id: "deepseek", label: "DeepSeek", detail: "DeepSeek V4 Pro and DeepSeek Flash (V4.1) chat models." },
  { id: "openai", label: "OpenAI", detail: "GPT chat and GPT Image generation." },
  { id: "google", label: "Google", detail: "Gemini chat and image generation." },
  { id: "xai", label: "xAI", detail: "Grok chat and image generation." },
  { id: "moonshot", label: "Moonshot AI", detail: "Kimi K3 and K2.6 chat models." },
  { id: "fireworks", label: "Fireworks AI", detail: "Kimi K3 and K3 Fast chat models." },
  { id: "xiaomi", label: "Xiaomi (MiMo)", detail: "MiMo V2.6 Pro, V2.6 Flash and V2.6 Pro UltraSpeed chat models." },
  { id: "gmicloud", label: "GMICloud", detail: "MiMo V2.6 Pro and Flash, and MiMo v2.5 Pro and v2.5 chat models." },
  { id: "zai", label: "z.ai", detail: "GLM chat and image generation." },
];
