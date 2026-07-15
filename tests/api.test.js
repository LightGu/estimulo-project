const assert = require("node:assert/strict");
const express = require("express");

const createApp = require("../src/api/app");

async function main() {
  const app = createApp({
    healthController: {
      redisClient: {
        ping: async () => "PONG",
      },
      dispatchQueueFactory: () => ({
        getJobCounts: async () => ({ waiting: 0, active: 0, completed: 2, failed: 0, delayed: 0 }),
      }),
      dispatchLogsService: {
        listRecent: async () => [{ criado_em: new Date(Date.now() - 5 * 60000).toISOString() }],
      },
    },
    campaignService: {
      create: async (payload) => ({ id: "campaign-1", ...payload }),
    },
  });

  const server = app.listen(0);

  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const postResponse = await fetch(`http://127.0.0.1:${port}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: "Campanha", organization_id: "org-1", cron_expression: "0 * * * *", ativo: true }),
    });

    assert.equal(postResponse.status, 201);

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthResponse.status, 200);
    const healthPayload = await healthResponse.json();
    assert.equal(healthPayload.status, "ok");
    assert.ok(healthPayload.checks.redis);
    assert.ok(healthPayload.queue);
    assert.ok(healthPayload.dispatch);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log("api tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
