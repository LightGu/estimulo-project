const assert = require("node:assert/strict");

const { createAISettingsService } = require("../src/services/ai/ai-settings.service");

async function testGetAgentAIOptionsUsesDefaultsWhenNotConfigured() {
  const service = createAISettingsService({
    settingsRepository: { getSettings: async () => ({}) },
  });

  const options = await service.getAgentAIOptions("transcription");

  assert.deepEqual(options, {
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"],
  });
}

async function testGetAgentAIOptionsUsesStoredModelsAndPrompt() {
  const service = createAISettingsService({
    settingsRepository: {
      getSettings: async () => ({
        ai_agents: {
          caption_generation: {
            models: ["gemini-2.5-pro", "gemini-2.5-flash"],
            prompt: "Prompt customizado de legenda",
          },
        },
      }),
    },
  });

  const options = await service.getAgentAIOptions("caption_generation");

  assert.deepEqual(options.models, ["gemini-2.5-pro", "gemini-2.5-flash"]);
  assert.equal(options.captionGenerationPrompt, "Prompt customizado de legenda");
}

async function testGetAgentAIOptionsFallsBackToDefaultPromptWhenNull() {
  const service = createAISettingsService({
    settingsRepository: {
      getSettings: async () => ({
        ai_agents: {
          caption_review: { models: ["gemini-2.5-flash"], prompt: null },
        },
      }),
    },
  });

  const options = await service.getAgentAIOptions("caption_review");

  assert.deepEqual(options.models, ["gemini-2.5-flash"]);
  assert.equal(options.captionReviewPrompt, undefined);
}

async function testGetAgentAIOptionsRejectsUnknownAgent() {
  const service = createAISettingsService({
    settingsRepository: { getSettings: async () => ({}) },
  });

  await assert.rejects(() => service.getAgentAIOptions("unknown"), /Agente de IA invalido/);
}

async function testTranscriptionOptionsNeverIncludePrompt() {
  const service = createAISettingsService({
    settingsRepository: {
      getSettings: async () => ({
        ai_agents: { transcription: { models: ["gemini-2.5-pro"] } },
      }),
    },
  });

  const options = await service.getAgentAIOptions("transcription");

  assert.deepEqual(Object.keys(options), ["models"]);
}

async function main() {
  await testGetAgentAIOptionsUsesDefaultsWhenNotConfigured();
  await testGetAgentAIOptionsUsesStoredModelsAndPrompt();
  await testGetAgentAIOptionsFallsBackToDefaultPromptWhenNull();
  await testGetAgentAIOptionsRejectsUnknownAgent();
  await testTranscriptionOptionsNeverIncludePrompt();

  console.log("ai-settings-service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
