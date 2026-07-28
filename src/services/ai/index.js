const AIProviderAdapter = require("./ai-provider-adapter");
const {
  DEFAULT_AI_PROVIDER,
  getAIProviderConfig,
  normalizeAIProvider,
} = require("../../config/ai");
const { GeminiAdapter } = require("./gemini-adapter");
const { OpenAIAdapter } = require("./openai-adapter");

function createAIProviderAdapter(options = {}) {
  if (options.adapter) {
    return options.adapter;
  }

  const provider = normalizeAIProvider(options.provider || getAIProviderConfig().provider);

  if (provider === "gemini") {
    return new GeminiAdapter(options.gemini || options);
  }

  if (provider === "openai") {
    return new OpenAIAdapter(options.openai || options);
  }

  throw new Error(`AI provider nao suportado: ${provider}`);
}

module.exports = {
  AIProviderAdapter,
  DEFAULT_AI_PROVIDER,
  GeminiAdapter,
  OpenAIAdapter,
  createAIProviderAdapter,
  normalizeAIProvider,
};
