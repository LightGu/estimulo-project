require("dotenv").config({ quiet: true });

// Configuracoes centralizadas da Evolution API usadas pelo wrapper de entrega.
const evolutionConfig = {
  // URL base da API, sem endpoint especifico.
  baseUrl: process.env.EVOLUTION_API_URL || "http://localhost:8080",
  // Chave enviada no header `apikey` em todas as requisicoes.
  apiKey: process.env.EVOLUTION_API_KEY || "change-me",
  // Instancia do WhatsApp criada/conectada na Evolution API.
  instanceName: process.env.EVOLUTION_INSTANCE_NAME || "estimulo-mvp",
  // Tempo maximo de espera por resposta antes de considerar falha.
  timeoutMs: Number(process.env.EVOLUTION_API_TIMEOUT_MS || 15000),
};

module.exports = {
  evolutionConfig,
};
