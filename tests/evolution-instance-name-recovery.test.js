const assert = require("node:assert/strict");

const {
  extractInstanceEntries,
  resolveRemoteInstanceName,
  resolveInstanceNames,
} = require("../src/services/evolution-instance-resolver");
const { createGroupsService } = require("../src/services/groups.service");
const { resolveInstance } = require("../src/services/evolution-instance-sender");

function notFoundError(name) {
  const error = new Error(`Falha na chamada para Evolution API (HTTP 404: The "${name}" instance does not exist)`);
  error.status = 404;
  return error;
}

async function main() {
  // ---------- extractInstanceEntries ----------
  {
    // v2 devolve array plano com `name`.
    assert.deepEqual(
      extractInstanceEntries([{ name: "a", ownerJid: "5511@s.whatsapp.net" }]),
      [{ name: "a", ownerJid: "5511@s.whatsapp.net" }]
    );

    // Formatos antigos: aninhado em `instance` e com `instanceName`.
    assert.deepEqual(extractInstanceEntries([{ instance: { instanceName: "b" } }]), [{ name: "b", ownerJid: null }]);

    // Entradas sem nome nao entram na lista.
    assert.deepEqual(extractInstanceEntries([{ foo: 1 }, null]), []);
  }

  // ---------- resolveRemoteInstanceName ----------
  {
    const remote = [
      { name: "Lina Estimulo Business", ownerJid: "5511936208898@s.whatsapp.net" },
      { name: "estimulo-novo", ownerJid: "5511936185837@s.whatsapp.net" },
    ];

    // Nome ja identico: devolve o proprio.
    assert.equal(
      resolveRemoteInstanceName({ instance_name: "estimulo-novo", phone_number: "5511936185837" }, remote),
      "estimulo-novo"
    );

    // Acento no nosso lado, sem acento na Evolution: casa pelo telefone.
    assert.equal(
      resolveRemoteInstanceName({ instance_name: "Lina Estímulo Business", phone_number: "5511936208898" }, remote),
      "Lina Estimulo Business"
    );

    // Sem telefone salvo, casa pelo nome normalizado (acento/caixa/separador).
    assert.equal(
      resolveRemoteInstanceName({ instance_name: "Lina Estímulo Business", phone_number: null }, remote),
      "Lina Estimulo Business"
    );

    // Instancia que realmente nao existe la: nao inventa correspondencia.
    assert.equal(
      resolveRemoteInstanceName({ instance_name: "numero-removido", phone_number: "5511000000000" }, remote),
      null
    );

    // Ambiguidade (dois candidatos equivalentes) nao pode virar chute - mandar
    // pelo numero errado e' pior do que falhar.
    assert.equal(
      resolveRemoteInstanceName({ instance_name: "Time Vendas", phone_number: null }, [
        { name: "time-vendas", ownerJid: null },
        { name: "Time Vendás", ownerJid: null },
      ]),
      null
    );
  }

  // ---------- sync: 404 por nome divergente se recupera e persiste ----------
  {
    const instances = [
      { id: "i1", instance_name: "Lina Estímulo Business", phone_number: "5511936208898", active: true },
    ];
    const updates = [];
    const attempted = [];

    const groupsService = createGroupsService({
      whatsappInstancesRepository: {
        listActive: async () => instances,
        update: async (id, payload) => {
          updates.push({ id, payload });
          return { id, ...payload };
        },
      },
      groupWhatsappInstancesRepository: {
        linkGroupToInstance: async () => null,
        unlinkGroupsNotIn: async () => null,
      },
      repository: {
        findByEvolutionGroupId: async () => null,
        create: async (payload) => ({ id: "g1", ...payload }),
        update: async (id, payload) => ({ id, ...payload }),
      },
      fetchEvolutionGroups: async ({ config }) => {
        attempted.push(config.instanceName);

        if (config.instanceName !== "Lina Estimulo Business") {
          throw notFoundError(config.instanceName);
        }

        return { data: [{ id: "123@g.us", subject: "Grupo A", participants: [{ id: "1" }] }] };
      },
      resolveInstanceNames: async (list) =>
        list.map((instance) => ({ instance, remoteName: "Lina Estimulo Business" })),
    });

    const result = await groupsService.syncGroupsFromEvolution({ getParticipants: true });

    // Tentou com o nome errado e repetiu com o nome real.
    assert.deepEqual(attempted, ["Lina Estímulo Business", "Lina Estimulo Business"]);

    // A correcao foi gravada, para os disparos pararem de falhar tambem.
    const nameFix = updates.find((entry) => entry.payload.instance_name);
    assert.equal(nameFix.payload.instance_name, "Lina Estimulo Business");

    // E o alerta de falha na tela foi limpo.
    const cleared = updates.find((entry) => entry.payload.last_sync_error === null);
    assert.ok(cleared, "esperava last_sync_error limpo apos recuperacao");
    assert.equal(result.groups.length, 1);
  }

  // ---------- sync: 404 real continua sendo falha ----------
  {
    const instances = [{ id: "i1", instance_name: "sumiu", phone_number: null, active: true }];
    const updates = [];

    const groupsService = createGroupsService({
      whatsappInstancesRepository: {
        listActive: async () => instances,
        update: async (id, payload) => {
          updates.push({ id, payload });
          return { id, ...payload };
        },
      },
      groupWhatsappInstancesRepository: {
        linkGroupToInstance: async () => null,
        unlinkGroupsNotIn: async () => null,
      },
      repository: {},
      fetchEvolutionGroups: async ({ config }) => {
        throw notFoundError(config.instanceName);
      },
      resolveInstanceNames: async (list) => list.map((instance) => ({ instance, remoteName: null })),
    });

    await assert.rejects(() => groupsService.syncGroupsFromEvolution({}), /EVOLUTION_SYNC_ALL_FAILED|Falha ao sincronizar/);

    const failure = updates.find((entry) => entry.payload.last_sync_error);
    assert.match(failure.payload.last_sync_error, /does not exist/);
  }

  // ---------- envio: 404 por nome divergente reenvia pelo nome real ----------
  {
    const instance = {
      id: "i1",
      instance_name: "Estímulo Sophia de Freitas",
      phone_number: "5511936185834",
      active: true,
      paused_at: null,
    };
    const updates = [];
    const attempted = [];

    const { sender } = await resolveInstance("i1", {
      whatsappInstancesRepository: {
        findById: async () => instance,
        listDispatchable: async () => [instance],
        listActive: async () => [instance],
        update: async (id, payload) => {
          updates.push({ id, payload });
          return { id, ...payload };
        },
      },
      resolveInstanceNames: async (list) =>
        list.map((entry) => ({ instance: entry, remoteName: "Estimulo Sophia de Freitas" })),
      createDeliveryProvider: (instanceName) => ({
        send: async () => {
          attempted.push(instanceName);

          if (instanceName !== "Estimulo Sophia de Freitas") {
            throw notFoundError(instanceName);
          }

          return { status: 201, messageId: "m1" };
        },
      }),
    });

    const result = await sender({ groupId: "123@g.us", message: "oi" });

    assert.equal(result.messageId, "m1");
    // Falhou com o nome do banco e reenviou com o nome real da Evolution.
    assert.deepEqual(attempted, ["Estímulo Sophia de Freitas", "Estimulo Sophia de Freitas"]);
    // E persistiu a correcao, para o proximo envio nao repetir o 404.
    assert.equal(updates[0].payload.instance_name, "Estimulo Sophia de Freitas");
  }

  // ---------- envio: erro que nao e' 404 sobe sem reenvio ----------
  {
    const instance = { id: "i1", instance_name: "n1", active: true, paused_at: null };
    let resolveCalls = 0;
    const attempted = [];

    const { sender } = await resolveInstance("i1", {
      whatsappInstancesRepository: {
        findById: async () => instance,
        listDispatchable: async () => [instance],
        listActive: async () => [instance],
        update: async () => null,
      },
      resolveInstanceNames: async (list) => {
        resolveCalls += 1;
        return list.map((entry) => ({ instance: entry, remoteName: "outro" }));
      },
      createDeliveryProvider: (instanceName) => ({
        send: async () => {
          attempted.push(instanceName);
          const error = new Error("Evolution API indisponivel ou sem resposta");
          error.code = "EVOLUTION_NO_RESPONSE";
          throw error;
        },
      }),
    });

    await assert.rejects(() => sender({ groupId: "1@g.us", message: "oi" }), /indisponivel/);
    // Uma unica tentativa e nenhuma consulta de nome: 500/timeout nao e' rename.
    assert.deepEqual(attempted, ["n1"]);
    assert.equal(resolveCalls, 0);
  }

  console.log("evolution-instance-name-recovery tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
