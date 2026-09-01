const assert = require("node:assert/strict");

const createApp = require("../src/api/app");

// whatsapp-instances-service.test.js ja cobre o controller chamando as
// funcoes exportadas diretamente (ex.: controller.setPaused(req, res)), mas
// isso nunca prova que a rota HTTP correspondente existe, usa o verbo certo
// ou passa pelo authGate como as demais - um erro de wiring em src/api/app.js
// (path errado, metodo trocado, rota esquecida) passaria batido. Este teste
// sobe o app real e bate nas rotas de /settings/whatsapp/* por HTTP.

function extractCookie(response, cookieName) {
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? `${cookieName}=${match[1]}` : "";
}

function fakeAuthService() {
  return {
    async authenticate({ username, password }) {
      if (username === "admin" && password === "senha-correta") {
        return { id: "user-1", username: "admin", is_admin: true };
      }
      return null;
    },
  };
}

function createFakeWhatsappInstancesService() {
  const instances = new Map([
    ["instance-1", { id: "instance-1", instance_name: "estimuloMvp", paused_at: null, priority: 0 }],
  ]);

  return {
    async list() {
      return Array.from(instances.values());
    },
    async registerInstance(payload) {
      const instanceName = String(payload.instance_name || "").trim();
      if (!instanceName) {
        throw new Error("instance_name is required");
      }
      if (instances.has(instanceName)) {
        throw new Error("Instance already exists");
      }
      const instance = { id: instanceName, instance_name: instanceName, paused_at: null, priority: instances.size };
      instances.set(instance.id, instance);
      return instance;
    },
    async generateQrCode(id) {
      if (!instances.has(id)) throw new Error("Instance not found");
      if (id === "instance-sem-qr") throw new Error("Evolution API did not return a QR code");
      return { instance_id: id, qr_base64: "data:image/png;base64,abc123" };
    },
    async checkConnectionStatus(id) {
      const instance = instances.get(id);
      if (!instance) throw new Error("Instance not found");
      return { ...instance, connection_state: "open" };
    },
    async removeInstance(id) {
      if (!instances.has(id)) throw new Error("Instance not found");
      instances.delete(id);
      return { removed: true, instance_id: id };
    },
    async setInstancePaused(id, paused) {
      const instance = instances.get(id);
      if (!instance) throw new Error("Instance not found");
      if (id === "instance-sem-migration") {
        const error = new Error('column "paused_at" of relation "whatsapp_instances" does not exist');
        error.code = "42703";
        throw error;
      }
      instance.paused_at = paused ? "2026-09-01T10:00:00.000Z" : null;
      return { ...instance };
    },
    async reorderPriority(orderedIds) {
      if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
        throw new Error("orderedIds must be a non-empty array");
      }
      return orderedIds;
    },
    async testConnection() {
      return { connected: true };
    },
    async getRotationSettings() {
      return { whatsapp_rotation_group_count: 2 };
    },
    async updateRotationSettings(payload) {
      const count = Number(payload.whatsapp_rotation_group_count);
      if (!Number.isInteger(count) || count < 1) {
        throw new Error("whatsapp_rotation_group_count must be an integer greater than or equal to 1");
      }
      return { whatsapp_rotation_group_count: count };
    },
  };
}

async function main() {
  const app = createApp({
    authGate: {
      authService: fakeAuthService(),
      sessionStoreOptions: { stateFile: null },
      rateLimiterOptions: { maxAttempts: 100, windowMs: 60 * 1000, baseLockMs: 200, maxLockMs: 1000 },
    },
    whatsappInstancesService: createFakeWhatsappInstancesService(),
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // Sem sessao, a rota esta atras do authGate igual as demais.
    const noSessionResponse = await fetch(`${baseUrl}/settings/whatsapp/instances`);
    assert.equal(noSessionResponse.status, 401);

    const loginResponse = await fetch(`${baseUrl}/access/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "senha-correta" }),
    });
    assert.equal(loginResponse.status, 200);
    const cookie = extractCookie(loginResponse, "estimulo_session");
    const auth = { Cookie: cookie };

    // GET /settings/whatsapp/instances
    const listResponse = await fetch(`${baseUrl}/settings/whatsapp/instances`, { headers: auth });
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.length, 1);

    // POST /settings/whatsapp/instances
    const registerResponse = await fetch(`${baseUrl}/settings/whatsapp/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ instance_name: "novaInstancia" }),
    });
    assert.equal(registerResponse.status, 201);

    const duplicateResponse = await fetch(`${baseUrl}/settings/whatsapp/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ instance_name: "novaInstancia" }),
    });
    assert.equal(duplicateResponse.status, 409);

    // GET .../:id/qr
    const qrResponse = await fetch(`${baseUrl}/settings/whatsapp/instances/instance-1/qr`, { headers: auth });
    assert.equal(qrResponse.status, 200);

    const qrMissingResponse = await fetch(`${baseUrl}/settings/whatsapp/instances/nao-existe/qr`, { headers: auth });
    assert.equal(qrMissingResponse.status, 404);

    // GET .../:id/status
    const statusResponse = await fetch(`${baseUrl}/settings/whatsapp/instances/instance-1/status`, { headers: auth });
    assert.equal(statusResponse.status, 200);

    // PATCH .../:id/pause - o caminho mais crítico: validacao de body, sucesso,
    // instancia inexistente e a migration ausente (503 com instrucao).
    const invalidPauseResponse = await fetch(`${baseUrl}/settings/whatsapp/instances/instance-1/pause`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({}),
    });
    assert.equal(invalidPauseResponse.status, 400);

    const pauseResponse = await fetch(`${baseUrl}/settings/whatsapp/instances/instance-1/pause`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(pauseResponse.status, 200);
    const paused = await pauseResponse.json();
    assert.ok(paused.paused_at);

    const pauseMissingResponse = await fetch(`${baseUrl}/settings/whatsapp/instances/nao-existe/pause`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(pauseMissingResponse.status, 404);

    const noMigrationInstances = createFakeWhatsappInstancesService();
    noMigrationInstances.setInstancePaused = async () => {
      const error = new Error('column "paused_at" of relation "whatsapp_instances" does not exist');
      error.code = "42703";
      throw error;
    };
    const appWithoutMigration = createApp({
      authGate: { enabled: false },
      whatsappInstancesService: noMigrationInstances,
    });
    const serverWithoutMigration = appWithoutMigration.listen(0);
    await new Promise((resolve) => serverWithoutMigration.once("listening", resolve));
    const baseUrlWithoutMigration = `http://127.0.0.1:${serverWithoutMigration.address().port}`;
    try {
      const missingMigrationResponse = await fetch(
        `${baseUrlWithoutMigration}/settings/whatsapp/instances/instance-1/pause`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paused: true }),
        }
      );
      assert.equal(missingMigrationResponse.status, 503);
      const missingMigrationPayload = await missingMigrationResponse.json();
      assert.match(missingMigrationPayload.error, /migration/i);
    } finally {
      await new Promise((resolve, reject) =>
        serverWithoutMigration.close((error) => (error ? reject(error) : resolve()))
      );
    }

    // POST .../reorder
    const reorderResponse = await fetch(`${baseUrl}/settings/whatsapp/instances/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ ordered_ids: ["instance-1", "novaInstancia"] }),
    });
    assert.equal(reorderResponse.status, 200);

    const reorderEmptyResponse = await fetch(`${baseUrl}/settings/whatsapp/instances/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ ordered_ids: [] }),
    });
    assert.equal(reorderEmptyResponse.status, 400);

    // POST /settings/whatsapp/test-connection
    const testConnectionResponse = await fetch(`${baseUrl}/settings/whatsapp/test-connection`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(testConnectionResponse.status, 200);

    // GET/PATCH /settings/whatsapp/rotation
    const getRotationResponse = await fetch(`${baseUrl}/settings/whatsapp/rotation`, { headers: auth });
    assert.equal(getRotationResponse.status, 200);

    const patchRotationResponse = await fetch(`${baseUrl}/settings/whatsapp/rotation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ whatsapp_rotation_group_count: 3 }),
    });
    assert.equal(patchRotationResponse.status, 200);

    const patchRotationInvalidResponse = await fetch(`${baseUrl}/settings/whatsapp/rotation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ whatsapp_rotation_group_count: 0 }),
    });
    assert.equal(patchRotationInvalidResponse.status, 400);

    // DELETE .../:id
    const deleteResponse = await fetch(`${baseUrl}/settings/whatsapp/instances/instance-1`, {
      method: "DELETE",
      headers: auth,
    });
    assert.equal(deleteResponse.status, 200);

    const deleteMissingResponse = await fetch(`${baseUrl}/settings/whatsapp/instances/instance-1`, {
      method: "DELETE",
      headers: auth,
    });
    assert.equal(deleteMissingResponse.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log("whatsapp instances controller HTTP tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
