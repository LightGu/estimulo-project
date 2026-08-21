const assert = require("node:assert/strict");

const createApp = require("../src/api/app");

// Cobre a rota multipart do Disparador Pontual com midia: o arquivo precisa
// chegar ao service como content.base64 (nunca gravado em disco), e group_ids
// (que multipart so transporta como string) precisa ser desserializado de
// volta para array antes de chegar no service.
async function withServer(mensagensService, run) {
  const app = createApp({
    authGate: { enabled: false },
    mensagensService,
  });
  const server = app.listen(0);

  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    await run(port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function buildFormData(fields, file) {
  const formData = new FormData();

  Object.entries(fields).forEach(([key, value]) => {
    formData.append(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
  });

  if (file) {
    formData.append("media", file.blob, file.name);
  }

  return formData;
}

async function testDispatchMediaRouteForwardsFileAsBase64() {
  const calls = [];
  const mensagensService = {
    async dispatchAdHoc(payload) {
      calls.push(payload);
      return { enviados: 1, falhas: 0, results: [{ ok: true, group_id: "group-a" }] };
    },
  };

  await withServer(mensagensService, async (port) => {
    const fileBytes = Buffer.from("fake-image-bytes");
    const formData = buildFormData(
      { group_ids: ["group-a", "group-b"], texto: "Convite para o evento" },
      { blob: new Blob([fileBytes], { type: "image/png" }), name: "convite.png" }
    );

    const response = await fetch(`http://127.0.0.1:${port}/mensagens/dispatch/media`, {
      method: "POST",
      body: formData,
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.enviados, 1);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].group_ids, ["group-a", "group-b"]);
    assert.equal(calls[0].texto, "Convite para o evento");
    assert.equal(calls[0].content.mimeType, "image/png");
    assert.equal(calls[0].content.fileName, "convite.png");
    assert.equal(calls[0].content.type, "image");
    assert.equal(Buffer.from(calls[0].content.base64, "base64").toString(), "fake-image-bytes");
  });
}

async function testScheduleMediaRouteForwardsFileAsBase64() {
  const calls = [];
  const mensagensService = {
    async scheduleAdHoc(payload) {
      calls.push(payload);
      return { scheduled: 1, jobs: [{ group_id: "group-a", group_nome: "Grupo A", scheduled_at: new Date().toISOString(), job_id: "job-1" }] };
    },
  };

  await withServer(mensagensService, async (port) => {
    const fileBytes = Buffer.from("fake-video-bytes");
    const windowStart = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const formData = buildFormData(
      {
        group_ids: ["group-a"],
        titulo: "Aviso importante",
        window_start: windowStart,
        window_end: windowEnd,
        jitter_delay_min_ms: 60000,
        jitter_delay_max_ms: 300000,
        persist_as_campaign: true,
      },
      { blob: new Blob([fileBytes], { type: "video/mp4" }), name: "aviso.mp4" }
    );

    const response = await fetch(`http://127.0.0.1:${port}/mensagens/dispatch/schedule/media`, {
      method: "POST",
      body: formData,
    });

    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.scheduled, 1);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].group_ids, ["group-a"]);
    assert.equal(calls[0].titulo, "Aviso importante");
    assert.equal(calls[0].content.mimeType, "video/mp4");
    assert.equal(calls[0].content.type, "video");
    assert.equal(Buffer.from(calls[0].content.base64, "base64").toString(), "fake-video-bytes");
  });
}

async function testDispatchMediaRouteMapsValidationErrorsTo400() {
  const mensagensService = {
    async dispatchAdHoc() {
      throw new Error("Selecione ao menos um grupo");
    },
  };

  await withServer(mensagensService, async (port) => {
    const formData = buildFormData({ group_ids: [], texto: "sem grupo" }, null);

    const response = await fetch(`http://127.0.0.1:${port}/mensagens/dispatch/media`, {
      method: "POST",
      body: formData,
    });

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, "Selecione ao menos um grupo");
  });
}

async function main() {
  await testDispatchMediaRouteForwardsFileAsBase64();
  await testScheduleMediaRouteForwardsFileAsBase64();
  await testDispatchMediaRouteMapsValidationErrorsTo400();

  console.log("mensagens-media-dispatch tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
