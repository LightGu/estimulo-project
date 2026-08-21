const { evolutionConfig } = require("../config/evolution");
const { createEvolutionClient, parseEvolutionError } = require("./evolution");

function buildInstanceClient(config = evolutionConfig) {
  return createEvolutionClient(config);
}

// POST /instance/create { instanceName, qrcode, integration }
async function createEvolutionInstance(instanceName, options = {}) {
  const client = buildInstanceClient(options.config);

  try {
    const response = await client.post("/instance/create", {
      instanceName,
      qrcode: true,
      integration: options.integration || "WHATSAPP-BAILEYS",
    });

    return {
      provider: "evolution",
      status: response.status,
      data: response.data,
    };
  } catch (error) {
    throw parseEvolutionError(error);
  }
}

// GET /instance/connect/:instance - retorna o QR code para conectar a instancia.
async function connectEvolutionInstance(instanceName, options = {}) {
  const client = buildInstanceClient(options.config);

  try {
    const response = await client.get(`/instance/connect/${instanceName}`);

    return {
      provider: "evolution",
      status: response.status,
      data: response.data,
    };
  } catch (error) {
    throw parseEvolutionError(error);
  }
}

// GET /instance/connectionState/:instance
async function getEvolutionConnectionState(instanceName, options = {}) {
  const client = buildInstanceClient(options.config);

  try {
    const response = await client.get(`/instance/connectionState/${instanceName}`);

    return {
      provider: "evolution",
      status: response.status,
      data: response.data,
    };
  } catch (error) {
    throw parseEvolutionError(error);
  }
}

// DELETE /instance/delete/:instance - faz logout antes para instancias ainda conectadas,
// tolerando falha do logout (instancia ja desconectada).
async function deleteEvolutionInstance(instanceName, options = {}) {
  const client = buildInstanceClient(options.config);

  try {
    await client.delete(`/instance/logout/${instanceName}`).catch(() => null);

    const response = await client.delete(`/instance/delete/${instanceName}`);

    return {
      provider: "evolution",
      status: response.status,
      data: response.data,
    };
  } catch (error) {
    const parsedError = parseEvolutionError(error);

    // A instancia pode ja nao existir mais do lado da Evolution (reset de
    // infra, remocao manual, etc) - sem tolerar o 404 aqui, removeInstance
    // nunca chega a apagar a linha local e o registro fica travado para
    // sempre, quebrando o sync de grupos com um erro que a UI nao deixa resolver.
    if (parsedError.status === 404) {
      return {
        provider: "evolution",
        status: 404,
        data: null,
        alreadyDeleted: true,
      };
    }

    throw parsedError;
  }
}

// GET /instance/fetchInstances
async function listEvolutionInstances(options = {}) {
  const client = buildInstanceClient(options.config);

  try {
    const response = await client.get("/instance/fetchInstances", {
      params: options.instanceName ? { instanceName: options.instanceName } : undefined,
    });

    return {
      provider: "evolution",
      status: response.status,
      data: response.data,
    };
  } catch (error) {
    throw parseEvolutionError(error);
  }
}

module.exports = {
  createEvolutionInstance,
  connectEvolutionInstance,
  getEvolutionConnectionState,
  deleteEvolutionInstance,
  listEvolutionInstances,
};
