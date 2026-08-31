const assert = require("node:assert/strict");

const { resolveDispatchSender } = require("../src/queues/dispatch");
const { sendToEvolution } = require("../src/services/evolution");

// Sem instance id e sem nenhuma instancia ativa cadastrada: unico caso legitimo
// em que o fallback historico (evolutionConfig.instanceName) ainda se aplica -
// instalacao que nunca migrou para a tabela whatsapp_instances.
async function testFallsBackToDefaultSenderWhenNoInstanceIdAndNoneActive() {
  const sender = await resolveDispatchSender(undefined, {
    whatsappInstancesRepository: {
      findById: async () => {
        throw new Error("nao deveria ser chamado sem whatsapp_instance_id");
      },
      listActive: async () => [],
    },
  });

  assert.equal(sender, sendToEvolution);
}

async function testResolvesInstanceScopedSenderWhenInstanceIdProvided() {
  const findByIdCalls = [];
  const sender = await resolveDispatchSender("instance-1", {
    whatsappInstancesRepository: {
      findById: async (id) => {
        findByIdCalls.push(id);
        return { id, instance_name: "estimulo-numero-2" };
      },
    },
  });

  assert.notEqual(sender, sendToEvolution);
  assert.equal(typeof sender, "function");
  assert.deepEqual(findByIdCalls, ["instance-1"]);
}

// Regressao: sem whatsapp_instance_id (disparo de teste, mensagem legada,
// instalacao com um unico numero), o sender agora usa a PRIMEIRA instancia
// ativa por prioridade - nunca mais o nome fixo em EVOLUTION_INSTANCE_NAME.
// Antes desta correcao, remover a instancia default da Evolution (o caso
// normal ao trocar de numero) quebrava com 404 "instance does not exist"
// todo envio sem instance_id explicito, mesmo com um numero configurado e
// conectado no banco - incluindo o botao "Enviar teste para este grupo".
async function testFallsBackToFirstActiveInstanceWhenNoInstanceIdProvided() {
  const listActiveCalls = [];
  const sender = await resolveDispatchSender(undefined, {
    whatsappInstancesRepository: {
      findById: async () => {
        throw new Error("nao deveria ser chamado sem whatsapp_instance_id");
      },
      listActive: async () => {
        listActiveCalls.push(true);
        return [
          { id: "instance-2", instance_name: "TesteLucas", priority: 0 },
          { id: "instance-3", instance_name: "outro-numero", priority: 1 },
        ];
      },
    },
  });

  assert.notEqual(sender, sendToEvolution, "deve resolver para a instancia ativa, nao para o sender fixo");
  assert.equal(typeof sender, "function");
  assert.equal(listActiveCalls.length, 1);
}

// Mesmo com um whatsapp_instance_id explicito, se a instancia referenciada foi
// removida (o id ficou orfao em algum job/grupo antigo), cai para a primeira
// ativa em vez de quebrar - e nao para o sender fixo.
async function testFallsBackToFirstActiveInstanceWhenInstanceMissing() {
  const sender = await resolveDispatchSender("missing-instance", {
    whatsappInstancesRepository: {
      findById: async () => null,
      listActive: async () => [{ id: "instance-2", instance_name: "TesteLucas", priority: 0 }],
    },
  });

  assert.notEqual(sender, sendToEvolution);
  assert.equal(typeof sender, "function");
}

// Repositorio sem listActive (compatibilidade com stubs mais antigos em
// outros testes/scripts): nao deve lancar, cai no sender fixo.
async function testDoesNotThrowWhenRepositoryHasNoListActive() {
  const sender = await resolveDispatchSender(undefined, {
    whatsappInstancesRepository: {
      findById: async () => {
        throw new Error("nao deveria ser chamado sem whatsapp_instance_id");
      },
    },
  });

  assert.equal(sender, sendToEvolution);
}

// Job ja agendado carregando o whatsapp_instance_id de um numero que foi
// PAUSADO depois: nao pode enviar por ele. Cai para o primeiro numero
// disponivel, senao a pausa so valeria para campanhas novas e os jobs ja na
// fila continuariam saindo pelo numero pausado.
async function testSkipsPausedPinnedInstanceAndFallsBackToDispatchable() {
  const listDispatchableCalls = [];
  const sender = await resolveDispatchSender("instance-paused", {
    whatsappInstancesRepository: {
      findById: async (id) => ({
        id,
        instance_name: "numero-pausado",
        paused_at: "2026-08-31T10:00:00.000Z",
      }),
      listDispatchable: async () => {
        listDispatchableCalls.push(true);
        return [{ id: "instance-2", instance_name: "TesteLucas", priority: 0 }];
      },
      listActive: async () => {
        throw new Error("deve preferir listDispatchable quando disponivel");
      },
    },
  });

  assert.notEqual(sender, sendToEvolution);
  assert.equal(typeof sender, "function");
  assert.equal(listDispatchableCalls.length, 1, "instancia pausada deve ser tratada como nao-resolvida");
}

// Numero pausado sendo o unico cadastrado: sem ninguem disponivel, nada de
// promover o pausado - cai no sender fixo, como qualquer outro caso sem
// instancia disparavel.
async function testDoesNotUsePausedInstanceWhenItIsTheOnlyOne() {
  const sender = await resolveDispatchSender("instance-paused", {
    whatsappInstancesRepository: {
      findById: async (id) => ({ id, instance_name: "numero-pausado", paused_at: "2026-08-31T10:00:00.000Z" }),
      listDispatchable: async () => [],
    },
  });

  assert.equal(sender, sendToEvolution);
}

// Fallback sem instance id continua ignorando pausados via listDispatchable.
async function testDefaultResolutionPrefersDispatchableList() {
  let usedDispatchable = false;
  const sender = await resolveDispatchSender(undefined, {
    whatsappInstancesRepository: {
      findById: async () => {
        throw new Error("nao deveria ser chamado sem whatsapp_instance_id");
      },
      listDispatchable: async () => {
        usedDispatchable = true;
        return [{ id: "instance-2", instance_name: "TesteLucas", priority: 0 }];
      },
      listActive: async () => {
        throw new Error("deve preferir listDispatchable quando disponivel");
      },
    },
  });

  assert.notEqual(sender, sendToEvolution);
  assert.equal(usedDispatchable, true);
}

// Todos os numeros cadastrados pausados: nao pode cair no sender fixo do .env,
// que enviaria pelo EVOLUTION_INSTANCE_NAME e furaria a pausa em silencio.
async function testThrowsWhenEveryRegisteredInstanceIsPaused() {
  await assert.rejects(
    () =>
      resolveDispatchSender(undefined, {
        whatsappInstancesRepository: {
          findById: async () => null,
          listDispatchable: async () => [],
          listActive: async () => [
            { id: "instance-1", paused_at: "2026-08-31T10:00:00.000Z" },
            { id: "instance-2", paused_at: "2026-08-31T10:05:00.000Z" },
          ],
        },
      }),
    (error) => error.code === "ALL_INSTANCES_PAUSED"
  );
}

// Um unico numero, pausado: mesmo bloqueio.
async function testThrowsWhenTheOnlyInstanceIsPaused() {
  await assert.rejects(
    () =>
      resolveDispatchSender("instance-1", {
        whatsappInstancesRepository: {
          findById: async (id) => ({ id, instance_name: "estimulo-novo", paused_at: "2026-08-31T10:00:00.000Z" }),
          listDispatchable: async () => [],
          listActive: async () => [{ id: "instance-1", paused_at: "2026-08-31T10:00:00.000Z" }],
        },
      }),
    (error) => error.code === "ALL_INSTANCES_PAUSED"
  );
}

// Contraste: nenhuma instancia CADASTRADA (instalacao legada) continua caindo no
// sender historico. So "tudo pausado" bloqueia.
async function testStillFallsBackWhenNothingIsRegistered() {
  const sender = await resolveDispatchSender(undefined, {
    whatsappInstancesRepository: {
      findById: async () => null,
      listDispatchable: async () => [],
      listActive: async () => [],
    },
  });

  assert.equal(sender, sendToEvolution);
}

async function main() {
  await testFallsBackToDefaultSenderWhenNoInstanceIdAndNoneActive();
  await testResolvesInstanceScopedSenderWhenInstanceIdProvided();
  await testFallsBackToFirstActiveInstanceWhenNoInstanceIdProvided();
  await testFallsBackToFirstActiveInstanceWhenInstanceMissing();
  await testDoesNotThrowWhenRepositoryHasNoListActive();
  await testSkipsPausedPinnedInstanceAndFallsBackToDispatchable();
  await testDoesNotUsePausedInstanceWhenItIsTheOnlyOne();
  await testDefaultResolutionPrefersDispatchableList();
  await testThrowsWhenEveryRegisteredInstanceIsPaused();
  await testThrowsWhenTheOnlyInstanceIsPaused();
  await testStillFallsBackWhenNothingIsRegistered();

  console.log("dispatch instance sender resolution tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
