const assert = require("node:assert/strict");

const createApp = require("../src/api/app");

function extractCookie(response, cookieName) {
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? `${cookieName}=${match[1]}` : "";
}

function fakeAuthService() {
  const validUser = { id: "user-1", username: "admin", active: true, password: "senha-correta" };

  return {
    async authenticate({ username, password }) {
      if (username === validUser.username && password === validUser.password) {
        return { id: validUser.id, username: validUser.username };
      }
      return null;
    },
  };
}

async function main() {
  const app = createApp({
    authGate: {
      authService: fakeAuthService(),
      ttlMs: 60 * 60 * 1000,
      sessionStoreOptions: { stateFile: null },
      rateLimiterOptions: { maxAttempts: 3, windowMs: 60 * 1000, baseLockMs: 200, maxLockMs: 1000 },
    },
    healthController: {
      redisClient: {
        ping: async () => "PONG",
      },
      dispatchQueueFactory: () => ({
        getJobCounts: async () => ({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
      }),
      dispatchLogsService: {
        listRecent: async () => [],
      },
    },
    organizationService: {
      list: async () => [{ id: "org-1", nome: "AMBEV" }],
    },
  });
  const server = app.listen(0);

  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const statusBeforeResponse = await fetch(`${baseUrl}/access/status`);
    assert.equal(statusBeforeResponse.status, 200);
    const statusBefore = await statusBeforeResponse.json();
    assert.equal(statusBefore.required, true);
    assert.equal(statusBefore.authorized, false);

    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.status, 200);

    const assetResponse = await fetch(`${baseUrl}/app/assets/js/nav.js`);
    assert.equal(assetResponse.status, 200);

    const pageBeforeResponse = await fetch(`${baseUrl}/app/index.html`, { redirect: "manual" });
    assert.equal(pageBeforeResponse.status, 302);
    assert.match(pageBeforeResponse.headers.get("location"), /^\/app\/access\.html\?next=/);

    const apiBeforeResponse = await fetch(`${baseUrl}/organizations`);
    assert.equal(apiBeforeResponse.status, 401);
    const apiBeforePayload = await apiBeforeResponse.json();
    assert.equal(apiBeforePayload.code, "ACCESS_REQUIRED");

    const wrongLoginResponse = await fetch(`${baseUrl}/access/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "errada" }),
    });
    assert.equal(wrongLoginResponse.status, 401);

    const loginResponse = await fetch(`${baseUrl}/access/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "senha-correta" }),
    });
    assert.equal(loginResponse.status, 200);
    const loginPayload = await loginResponse.json();
    assert.equal(loginPayload.authorized, true);
    assert.equal(loginPayload.username, "admin");
    assert.ok(loginPayload.expires_at);

    const sessionCookie = extractCookie(loginResponse, "estimulo_session");
    assert.ok(sessionCookie, "login response deveria enviar o cookie de sessao");

    const statusAfterResponse = await fetch(`${baseUrl}/access/status`, {
      headers: { Cookie: sessionCookie },
    });
    const statusAfter = await statusAfterResponse.json();
    assert.equal(statusAfter.authorized, true);
    assert.equal(statusAfter.username, "admin");

    const apiAfterResponse = await fetch(`${baseUrl}/organizations`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(apiAfterResponse.status, 200);
    const apiAfterPayload = await apiAfterResponse.json();
    assert.deepEqual(apiAfterPayload, [{ id: "org-1", nome: "AMBEV" }]);

    const pageAfterResponse = await fetch(`${baseUrl}/app/index.html`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(pageAfterResponse.status, 200);
    assert.match(await pageAfterResponse.text(), /Painel geral/);

    // Sem o cookie, mesmo apos alguem ter feito login, o painel continua bloqueado.
    const apiNoCookieResponse = await fetch(`${baseUrl}/organizations`);
    assert.equal(apiNoCookieResponse.status, 401);

    // Logout invalida a sessao imediatamente.
    const logoutResponse = await fetch(`${baseUrl}/access/logout`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });
    assert.equal(logoutResponse.status, 200);

    const apiAfterLogoutResponse = await fetch(`${baseUrl}/organizations`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(apiAfterLogoutResponse.status, 401);

    // Forca bruta: apos maxAttempts (3) tentativas erradas, a chave fica bloqueada (429).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await fetch(`${baseUrl}/access/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "outro-usuario", password: `tentativa-${attempt}` }),
      });
    }

    const lockedResponse = await fetch(`${baseUrl}/access/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "outro-usuario", password: "mais-uma-tentativa" }),
    });
    assert.equal(lockedResponse.status, 429);
    const lockedPayload = await lockedResponse.json();
    assert.equal(lockedPayload.code, "TOO_MANY_ATTEMPTS");

    // Mesmo com a senha certa, a chave bloqueada nao consegue logar ate o lock expirar.
    const lockedButCorrectResponse = await fetch(`${baseUrl}/access/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "outro-usuario", password: "senha-correta" }),
    });
    assert.equal(lockedButCorrectResponse.status, 429);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log("auth gate tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
