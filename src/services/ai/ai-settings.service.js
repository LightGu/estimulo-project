const settingsRepository = require("../../repositories/settings.repository");

// Modelos que a API do Gemini ja recusa para chaves novas ("This model
// models/... is no longer available to new users"). Ficam listados aqui para que
// configuracoes antigas salvas no banco sejam limpas em tempo de execucao, em vez
// de derrubar transcricao/legenda/revisao com 404 em cada envio.
const RETIRED_GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-lite-preview-09-2025",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  "gemini-1.5-pro",
  "gemini-2.0-flash-exp",
];

const ALLOWED_GEMINI_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
];

// A cascata padrao usa modelos verificados na API e termina nos aliases
// "-latest", que continuam validos quando o Google retira uma versao numerada.
const DEFAULT_AI_AGENTS_SETTINGS = {
  transcription: {
    models: ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"],
  },
  caption_generation: {
    models: ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-flash-latest"],
    prompt: null,
  },
  caption_review: {
    models: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-lite-latest"],
    prompt: null,
  },
};

const AGENT_PROMPT_OPTION_KEY = {
  caption_generation: "captionGenerationPrompt",
  caption_review: "captionReviewPrompt",
};

function sanitizeModels(models) {
  return (Array.isArray(models) ? models : [])
    .filter(Boolean)
    .filter((model) => !RETIRED_GEMINI_MODELS.includes(model))
    .filter((model, index, all) => all.indexOf(model) === index);
}

function normalizeAgentSettings(agentKey, rawAgentSettings) {
  const defaults = DEFAULT_AI_AGENTS_SETTINGS[agentKey];
  // Configuracao salva antes de um modelo ser retirado nao pode continuar sendo
  // usada: sem essa limpeza a cascata inteira pode ser composta de modelos mortos
  // e todo envio falha com "no longer available".
  const storedModels = sanitizeModels(rawAgentSettings && rawAgentSettings.models);
  const models = storedModels.length ? storedModels : defaults.models;
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
module.exports.RETIRED_GEMINI_MODELS = RETIRED_GEMINI_MODELS;
module.exports.createAISettingsService = createAISettingsService;
module.exports.normalizeAgentSettings = normalizeAgentSettings;
module.exports.sanitizeModels = sanitizeModels;
