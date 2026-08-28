const assert = require("node:assert/strict");

const createApp = require("../src/api/app");

// Regressao: o nome exibido no user-chip (canto superior direito) vinha de
// settings.profile_name - uma linha GLOBAL unica no Supabase, compartilhada
// por todo mundo. Qualquer pessoa logada via o mesmo nome, e mudar em
// Configuracoes mudava para TODAS as sessoes ativas ao mesmo tempo.
// Agora cada app_user tem seu proprio display_name, editavel so pela propria
// sessao (PATCH /account/profile, sem authGate.requireAdmin - nao e' uma
// acao administrativa) e refletido em /access/status.

function extractCookie(response, cookieName) {
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? `${cookieName}=${match[1]}` : "";
}

function fakeUsersDb() {
  return {
    "user-lina": { id: "user-lina", username: "lina", password: "senha-lina", is_admin: false, display_name: "Lina" },
    "user-gustavo": { id: "user-gustavo", username: "gustavo", password: "senha-gustavo", is_admin: false, display_name: null },
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
  const usersById = fakeUsersDb();
  const usersByUsername = Object.fromEntries(Object.values(usersById).map((user) => [user.username, user]));

  const authServiceForGate = {
    async authenticate({ username, password }) {
      const user = usersByUsername[username];
      if (user && user.password === password) {
        return { id: user.id, username: user.username, is_admin: user.is_admin };
      }
      return null;
    },
    async getUserById(id) {
      const user = usersById[id];
      return user ? { id: user.id, username: user.username, is_admin: user.is_admin, display_name: user.display_name } : null;
    },
  };

  const app = createApp({
    authGate: {
      authService: authServiceForGate,
      sessionStoreOptions: { stateFile: null },
      rateLimiterOptions: { maxAttempts: 100, windowMs: 60 * 1000, baseLockMs: 200, maxLockMs: 1000 },
    },
    authService: {
      async updateDisplayName(id, displayName) {
        const trimmed = String(displayName || "").trim();
        if (!trimmed) throw new Error("Informe um nome de exibicao.");
        usersById[id].display_name = trimmed;
        return { id, username: usersById[id].username, display_name: trimmed };
      },
    },
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const linaCookie = await login(baseUrl, "lina", "senha-lina");
    const gustavoCookie = await login(baseUrl, "gustavo", "senha-gustavo");

    // /access/status ja reflete o display_name cadastrado.
    const linaStatus = await (await fetch(`${baseUrl}/access/status`, { headers: { Cookie: linaCookie } })).json();
    assert.equal(linaStatus.display_name, "Lina");

    // Sem display_name ainda: cai no username (nunca fica em branco/null pro chip).
    const gustavoStatusBefore = await (
      await fetch(`${baseUrl}/access/status`, { headers: { Cookie: gustavoCookie } })
    ).json();
    assert.equal(gustavoStatusBefore.display_name, "gustavo");

    // Gustavo edita o PROPRIO nome.
    const updateResponse = await fetch(`${baseUrl}/account/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: gustavoCookie },
      body: JSON.stringify({ display_name: "Gustavo Luz" }),
    });
    assert.equal(updateResponse.status, 200);

    // Reflete na PROPRIA sessao imediatamente.
    const gustavoStatusAfter = await (
      await fetch(`${baseUrl}/access/status`, { headers: { Cookie: gustavoCookie } })
    ).json();
    assert.equal(gustavoStatusAfter.display_name, "Gustavo Luz");

    // Nao afeta a sessao de OUTRA pessoa (o bug original: mudava pra todo mundo).
    const linaStatusAfter = await (await fetch(`${baseUrl}/access/status`, { headers: { Cookie: linaCookie } })).json();
    assert.equal(linaStatusAfter.display_name, "Lina", "editar o nome de gustavo nao pode mudar o de lina");

    // Sem sessao: 401, antes mesmo de tentar validar o body.
    const noSessionResponse = await fetch(`${baseUrl}/account/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: "Invasor" }),
    });
    assert.equal(noSessionResponse.status, 401);

    // Nome vazio: 400.
    const emptyNameResponse = await fetch(`${baseUrl}/account/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: linaCookie },
      body: JSON.stringify({ display_name: "   " }),
    });
    assert.equal(emptyNameResponse.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log("app users own profile tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
