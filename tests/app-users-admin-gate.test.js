const assert = require("node:assert/strict");

const createApp = require("../src/api/app");

// Regressao: criar ou (des)ativar um login do painel deixou de depender de
// uma senha mestra compartilhada (ESTIMULO_ADMIN_MASTER_PASSWORD, removida) e
// passou a exigir is_admin=true na PROPRIA sessao de quem chama
// (authGate.requireAdmin). Isso garante que uma sessao comum nunca consiga
// promover a si mesma nem criar outros logins, mesmo estando autenticada.

function extractCookie(response, cookieName) {
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? `${cookieName}=${match[1]}` : "";
}

function fakeAuthService() {
  const users = {
    admin: { id: "user-admin", username: "admin", password: "senha-admin", is_admin: true },
    operador: { id: "user-operador", username: "operador", password: "senha-operador", is_admin: false },
  };

  return {
    async authenticate({ username, password }) {
      const user = users[username];
      if (user && user.password === password) {
        return { id: user.id, username: user.username, is_admin: user.is_admin };
      }
      return null;
    },
  };
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/access/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, `login de "${username}" deveria funcionar`);
  return extractCookie(response, "estimulo_session");
}

async function main() {
  const app = createApp({
    authGate: {
      authService: fakeAuthService(),
      sessionStoreOptions: { stateFile: null },
      rateLimiterOptions: { maxAttempts: 100, windowMs: 60 * 1000, baseLockMs: 200, maxLockMs: 1000 },
    },
    authService: {
      listUsers: async () => [],
      createUser: async ({ username }) => ({ id: "novo-id", username, active: true, is_admin: false }),
      setActive: async (id, active) => ({ id, active }),
    },
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const adminCookie = await login(baseUrl, "admin", "senha-admin");
    const operadorCookie = await login(baseUrl, "operador", "senha-operador");

    const statusAdminResponse = await fetch(`${baseUrl}/access/status`, { headers: { Cookie: adminCookie } });
    const statusAdmin = await statusAdminResponse.json();
    assert.equal(statusAdmin.is_admin, true, "sessao do admin deveria expor is_admin=true");

    const statusOperadorResponse = await fetch(`${baseUrl}/access/status`, { headers: { Cookie: operadorCookie } });
    const statusOperador = await statusOperadorResponse.json();
    assert.equal(statusOperador.is_admin, false, "sessao do operador deveria expor is_admin=false");

    // Sem sessao nenhuma: bloqueado pelo authGate normal (401), antes mesmo
    // de chegar no requireAdmin.
    const noSessionResponse = await fetch(`${baseUrl}/settings/app-users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "x", password: "senhaforte1" }),
    });
    assert.equal(noSessionResponse.status, 401);

    // Sessao valida mas sem is_admin: requireAdmin barra com 403.
    const operadorCreateResponse = await fetch(`${baseUrl}/settings/app-users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: operadorCookie },
      body: JSON.stringify({ username: "invasor", password: "senhaforte1" }),
    });
    assert.equal(operadorCreateResponse.status, 403);

    const operadorPatchResponse = await fetch(`${baseUrl}/settings/app-users/user-operador`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: operadorCookie },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(operadorPatchResponse.status, 403);

    // Sessao com is_admin=true passa normalmente.
    const adminCreateResponse = await fetch(`${baseUrl}/settings/app-users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ username: "novo", password: "senhaforte1" }),
    });
    assert.equal(adminCreateResponse.status, 201);
    const created = await adminCreateResponse.json();
    assert.equal(created.username, "novo");

    const adminPatchResponse = await fetch(`${baseUrl}/settings/app-users/user-operador`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(adminPatchResponse.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log("app users admin gate tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
