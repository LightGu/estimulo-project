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
    groupService: {
      listWithoutSegment: async () => [
        {
          id: "group-1",
          nome: "Grupo sem segmento",
          evolution_group_id: "120363@g.us",
          segmento: null,
          envia_video: false,
        },
      ],
      syncGroupsFromEvolution: async () => ({
        inserted: 1,
        updated: 1,
        ignored: 0,
        groups: [{ id: "120363@g.us", nome: "Grupo", quantidade_membros: 10 }],
      }),
      updateOperationalSettings: async (id, payload) => ({
        id,
        nome: "Grupo sem segmento",
        evolution_group_id: "120363@g.us",
        quantidade_membros: 10,
        segmento: payload.segmento,
        envia_video: payload.envia_video,
        trilha_override: payload.trilha_override,
      }),
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

    const groupSyncResponse = await fetch(`http://127.0.0.1:${port}/groups/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: "org-1" }),
    });

    assert.equal(groupSyncResponse.status, 200);
    const groupSyncPayload = await groupSyncResponse.json();
    assert.equal(groupSyncPayload.inserted, 1);
    assert.equal(groupSyncPayload.updated, 1);
    assert.equal(groupSyncPayload.ignored, 0);
    assert.deepEqual(groupSyncPayload.groups, [{ id: "120363@g.us", nome: "Grupo", quantidade_membros: 10 }]);

    const unclassifiedGroupsResponse = await fetch(`http://127.0.0.1:${port}/groups/unclassified`);
    assert.equal(unclassifiedGroupsResponse.status, 200);
    const unclassifiedGroupsPayload = await unclassifiedGroupsResponse.json();
    assert.deepEqual(unclassifiedGroupsPayload, [
      {
        id: "group-1",
        nome: "Grupo sem segmento",
        evolution_group_id: "120363@g.us",
        segmento: null,
        envia_video: false,
      },
    ]);

    const operationalSettingsResponse = await fetch(`http://127.0.0.1:${port}/groups/group-1/operational-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segmento: "Pre infancia",
        envia_video: true,
        trilha_override: "Trilha A",
        nome: "Nao deve ser usado",
      }),
    });

    assert.equal(operationalSettingsResponse.status, 200);
    const operationalSettingsPayload = await operationalSettingsResponse.json();
    assert.deepEqual(operationalSettingsPayload, {
      id: "group-1",
      nome: "Grupo sem segmento",
      evolution_group_id: "120363@g.us",
      quantidade_membros: 10,
      segmento: "Pre infancia",
      envia_video: true,
      trilha_override: "Trilha A",
    });

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthResponse.status, 200);
    const healthPayload = await healthResponse.json();
    assert.equal(healthPayload.status, "ok");
    assert.equal(healthPayload.checks.application.status, "ok");
    assert.equal(healthPayload.checks.redis.status, "ok");
    assert.ok(healthPayload.checks.redis);

    const unhealthyApp = createApp({
      healthController: {
        redisClient: {
          ping: async () => {
            throw new Error("Redis unavailable");
          },
        },
      },
      campaignService: {
        create: async (payload) => ({ id: "campaign-1", ...payload }),
      },
      groupService: {
        listWithoutSegment: async () => [],
        syncGroupsFromEvolution: async () => ({
          inserted: 0,
          updated: 0,
          ignored: 0,
          groups: [],
        }),
        updateOperationalSettings: async (id, payload) => ({ id, ...payload }),
      },
    });

    const unhealthyServer = unhealthyApp.listen(0);
    await new Promise((resolve) => unhealthyServer.once("listening", resolve));
    const unhealthyPort = unhealthyServer.address().port;

    try {
      const unhealthyResponse = await fetch(`http://127.0.0.1:${unhealthyPort}/health`);
      assert.equal(unhealthyResponse.status, 503);

      const unhealthyPayload = await unhealthyResponse.json();
      assert.equal(unhealthyPayload.status, "error");
      assert.equal(unhealthyPayload.checks.application.status, "ok");
      assert.equal(unhealthyPayload.checks.redis.status, "error");
      assert.equal(unhealthyPayload.checks.redis.error, "Redis unavailable");
    } finally {
      await new Promise((resolve, reject) => unhealthyServer.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log("api tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
