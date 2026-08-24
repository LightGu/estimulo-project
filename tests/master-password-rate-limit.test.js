const assert = require("node:assert/strict");

const createApp = require("../src/api/app");

// Regressao: POST /access/register e' publico de proposito (auto-cadastro
// sabendo a senha mestra) e por isso nao passa pelo authGate. Sem limite de
// tentativas, a senha mestra - um unico segredo compartilhado - podia ser
// varrida por forca bruta na velocidade da rede, e acertar da acesso total ao
// painel, inclusive ao disparo para os grupos de WhatsApp.
async function main() {
  const app = createApp({
    authGate: {
      authService: { async authenticate() { return null; } },
      sessionStoreOptions: { stateFile: null },
      masterPasswordRateLimiterOptions: {
        maxAttempts: 3,
        windowMs: 60 * 1000,
        baseLockMs: 200,
        maxLockMs: 1000,
      },
    },
    authService: {
      async createUser({ username }) {
        return { id: "user-novo", username, active: true };
      },
    },
  });

  process.env.ESTIMULO_ADMIN_MASTER_PASSWORD = "senha-mestra-correta";

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  function register(masterPassword) {
    return fetch(`${baseUrl}/access/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "invasor",
        password: "senhaforte1",
        master_password: masterPassword,
      }),
    });
  }

  try {
    // As primeiras tentativas erradas ainda respondem 403 (senha mestra incorreta).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await register(`chute-${attempt}`);
      assert.equal(response.status, 403, `tentativa ${attempt} deveria devolver 403`);
    }

    // Atingido o limite, o endpoint passa a recusar antes mesmo de comparar a senha.
    const blockedResponse = await register("chute-4");
    assert.equal(blockedResponse.status, 429);
    const blockedPayload = await blockedResponse.json();
    assert.equal(blockedPayload.code, "TOO_MANY_ATTEMPTS");
    assert.ok(Number(blockedResponse.headers.get("retry-after")) >= 0);

    // O bloqueio vale inclusive para quem acerta a senha mestra: sem isso, o
    // atacante so precisaria continuar chutando ate o acerto passar.
    const blockedButCorrect = await register("senha-mestra-correta");
    assert.equal(blockedButCorrect.status, 429);

    // Depois do lock expirar, o fluxo legitimo volta a funcionar normalmente.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const allowedResponse = await register("senha-mestra-correta");
    assert.equal(allowedResponse.status, 201);
    const created = await allowedResponse.json();
    assert.equal(created.username, "invasor");
  } finally {
    delete process.env.ESTIMULO_ADMIN_MASTER_PASSWORD;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log("master password rate limit tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
