const AIProviderAdapter = require("./ai-provider-adapter");
const { GeminiAdapter } = require("./gemini-adapter");

function createAIProviderAdapter(options = {}) {
  if (options.adapter) {
    return options.adapter;
  }

  return new GeminiAdapter(options.gemini || options);
}

module.exports = {
  AIProviderAdapter,
  GeminiAdapter,
  createAIProviderAdapter,
};
