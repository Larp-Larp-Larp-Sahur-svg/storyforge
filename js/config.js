// config.js — AI provider presets. All OpenAI-compatible /chat/completions.
// Ranked roughly cheapest/freest first. Prompt caching (DeepSeek/OpenAI/GLM)
// makes StoryForge's repeated turns far cheaper because the prefix is static.

export const PROVIDERS = {
  offline: {
    label: "Offline Demo — no AI, no key, $0",
    base: "", model: "template-engine", needsKey: false, keyUrl: "",
    note: "Plays fully with zero network using the pure-math engine. Best for testing.",
  },
  ollama: {
    label: "Ollama — local, no key, free + offline",
    base: "http://localhost:11434/v1", model: "llama3.1", needsKey: false, keyUrl: "https://ollama.com",
    note: "Run `ollama pull llama3.1` then `ollama serve`. 100% local, unlimited, free.",
  },
  glm: {
    label: "GLM-4-Flash (Zhipu) — FREE",
    base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", needsKey: true,
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    note: "Free tier, fast, great at JSON. International endpoint: https://api.z.ai/api/paas/v4",
  },
  glm_intl: {
    label: "GLM-4-Flash (Z.ai international) — FREE",
    base: "https://api.z.ai/api/paas/v4", model: "glm-4-flash", needsKey: true,
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    note: "Same free model, international endpoint.",
  },
  openrouter_free: {
    label: "OpenRouter — free models (incl. DeepSeek)",
    base: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat-v3-0324:free", needsKey: true,
    keyUrl: "https://openrouter.ai/keys",
    note: "Use any :free model, e.g. deepseek/deepseek-chat-v3-0324:free, meta-llama/llama-3.3-70b-instruct:free.",
  },
  deepseek: {
    label: "DeepSeek direct — cheap + prompt caching",
    base: "https://api.deepseek.com", model: "deepseek-chat", needsKey: true,
    keyUrl: "https://platform.deepseek.com",
    note: "deepseek-chat (V3). Automatic context caching bills repeat turns ~10x cheaper. Your $14.99 lasts a very long time.",
  },
  groq: {
    label: "Groq — fast free tier",
    base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", needsKey: true,
    keyUrl: "https://console.groq.com/keys",
    note: "Generous free tier, extremely fast.",
  },
  custom: {
    label: "Custom OpenAI-compatible endpoint",
    base: "", model: "", needsKey: true, keyUrl: "",
    note: "Any provider exposing POST {base}/chat/completions.",
  },
};

// Per-turn output length presets (output tokens dominate narration cost).
export const LENGTHS = {
  lean: { label: "Lean · ~1 short para (cheapest)", tokens: 280 },
  normal: { label: "Normal · 2-3 paras", tokens: 430 },
  rich: { label: "Rich · fuller prose", tokens: 650 },
};

export const DEFAULT_SETTINGS = {
  provider: "glm",
  base: PROVIDERS.glm.base,
  model: PROVIDERS.glm.model,
  apiKey: "",
  temperature: 1.0,
  length: "normal",
  maxTokens: LENGTHS.normal.tokens,
  contextDepth: "full", // 'lean' sends a smaller bible — cheaper on providers without prompt caching
  economy: false,        // force lean length per turn to minimize tokens
  difficulty: "normal",  // story | normal | brutal (default for new runs)
  theme: "auto",         // auto | light | dark
};
