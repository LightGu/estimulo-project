const settingsRepository = require("../../repositories/settings.repository");

const ALLOWED_GEMINI_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-lite-preview-09-2025",
  "gemini-flash-latest",
];

const DEFAULT_AI_AGENTS_SETTINGS = {
  transcription: {
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"],
  },
  caption_generation: {
    models: ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-2.5-flash-lite"],
    prompt: null,
  },
  caption_review: {
    models: ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-2.5-flash-lite"],
    prompt: null,
  },
};

const AGENT_PROMPT_OPTION_KEY = {
  caption_generation: "captionGenerationPrompt",
  caption_review: "captionReviewPrompt",
};

function normalizeAgentSettings(agentKey, rawAgentSettings) {
  const defaults = DEFAULT_AI_AGENTS_SETTINGS[agentKey];
  const models =
    Array.isArray(rawAgentSettings && rawAgentSettings.models) && rawAgentSettings.models.length
      ? rawAgentSettings.models
      : defaults.models;
  const prompt =
    rawAgentSettings && typeof rawAgentSettings.prompt === "string" && rawAgentSettings.prompt.trim()
      ? rawAgentSettings.prompt
      : null;

  return { models, prompt };
}

function createAISettingsService(dependencies = {}) {
  const repository = dependencies.settingsRepository || settingsRepository;

  async function getAIAgentsSettings() {
    const settings = await repository.getSettings();
    const stored = (settings && settings.ai_agents) || {};

    return {
      transcription: normalizeAgentSettings("transcription", stored.transcription),
      caption_generation: normalizeAgentSettings("caption_generation", stored.caption_generation),
      caption_review: normalizeAgentSettings("caption_review", stored.caption_review),
    };
  }

  async function getAgentAIOptions(agentKey) {
    const agentsSettings = await getAIAgentsSettings();
    const agentSettings = agentsSettings[agentKey];

    if (!agentSettings) {
      throw new Error(`Agente de IA invalido: ${agentKey}`);
    }

    const options = { models: agentSettings.models };
    const promptOptionKey = AGENT_PROMPT_OPTION_KEY[agentKey];

    if (promptOptionKey && agentSettings.prompt) {
      options[promptOptionKey] = agentSettings.prompt;
    }

    return options;
  }

  return {
    getAgentAIOptions,
    getAIAgentsSettings,
  };
}

module.exports = createAISettingsService();
module.exports.ALLOWED_GEMINI_MODELS = ALLOWED_GEMINI_MODELS;
module.exports.DEFAULT_AI_AGENTS_SETTINGS = DEFAULT_AI_AGENTS_SETTINGS;
module.exports.createAISettingsService = createAISettingsService;
module.exports.normalizeAgentSettings = normalizeAgentSettings;
