const DEFAULT_AI_PROVIDER = "gemini";

function normalizeAIProvider(value) {
  const provider = String(value || DEFAULT_AI_PROVIDER)
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");

  if (provider === "gpt" || provider === "chatgpt" || provider === "open-ai") {
    return "openai";
  }

  if (provider === "google" || provider === "google-gemini") {
    return "gemini";
  }

  return provider;
}

function getAIProviderConfig(env = process.env) {
  return {
    provider: normalizeAIProvider(env.AI_PROVIDER || env.VIDEO_CAPTION_PROVIDER || DEFAULT_AI_PROVIDER),
  };
}

module.exports = {
  DEFAULT_AI_PROVIDER,
  getAIProviderConfig,
  normalizeAIProvider,
};
