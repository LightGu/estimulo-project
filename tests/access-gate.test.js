const assert = require("node:assert/strict");

const createApp = require("../src/api/app");

async function main() {
  const app = createApp({
    accessGate: {
      password: "senha-correta",
      ttlMs: 60 * 60 * 1000,
      stateFile: null,
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
      body: JSON.stringify({ password: "errada" }),
    });
    assert.equal(wrongLoginResponse.status, 401);

    const loginResponse = await fetch(`${baseUrl}/access/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "senha-correta" }),
    });
    assert.equal(loginResponse.status, 200);
    const loginPayload = await loginResponse.json();
    assert.equal(loginPayload.authorized, true);
    assert.ok(loginPayload.expires_at);

    const statusAfterResponse = await fetch(`${baseUrl}/access/status`);
    const statusAfter = await statusAfterResponse.json();
    assert.equal(statusAfter.authorized, true);

    const apiAfterResponse = await fetch(`${baseUrl}/organizations`);
    assert.equal(apiAfterResponse.status, 200);
    const apiAfterPayload = await apiAfterResponse.json();
    assert.deepEqual(apiAfterPayload, [{ id: "org-1", nome: "AMBEV" }]);

    const pageAfterResponse = await fetch(`${baseUrl}/app/index.html`);
    assert.equal(pageAfterResponse.status, 200);
    assert.match(await pageAfterResponse.text(), /Painel geral/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log("access gate tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
