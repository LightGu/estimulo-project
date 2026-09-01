const assert = require("node:assert/strict");

const { runFixEvolutionInstanceNames } = require("../scripts/fix-evolution-instance-names");

// Este script grava direto em whatsapp_instances quando chamado com --apply,
// fora do fluxo normal (sync/envio se auto-corrigem sozinhos ao ver um 404).
// O risco concreto e o dry-run (padrao, sem --apply) escrever por engano, ou
// o --apply corrigir uma instancia errada. Os dois casos abaixo garantem
// exatamente isso, sem precisar de uma Evolution API nem Supabase reais.

function noopLog() {}

async function main() {
  // ---------- dry-run (padrao): detecta divergencia mas NUNCA escreve ----------
  {
    const updateCalls = [];
    const instancesRepository = {
      findAll: async () => [
        { id: "instance-1", instance_name: "linaEstimuloBusiness", phone_number: null },
      ],
      update: async (...args) => {
        updateCalls.push(args);
        throw new Error("dry-run nao deveria chamar update");
      },
    };

    const result = await runFixEvolutionInstanceNames({
      apply: false,
      instancesRepository,
      listEvolutionInstances: async () => ({
        data: [{ name: "linaestimulobusiness", ownerJid: "5511999999999@s.whatsapp.net" }],
      }),
      evolutionConfig: { baseUrl: "http://evolution.local" },
      log: noopLog,
    });

    assert.equal(updateCalls.length, 0, "dry-run nunca deve gravar no banco");
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].remoteName, "linaestimulobusiness");
    assert.equal(result.applied.length, 0);
  }

  // ---------- --apply: corrige exatamente a instancia divergente, com o nome certo ----------
  {
    const updateCalls = [];
    const instancesRepository = {
      findAll: async () => [
        { id: "instance-1", instance_name: "linaEstimuloBusiness", phone_number: null },
        { id: "instance-2", instance_name: "estimuloMvp", phone_number: null },
      ],
      update: async (id, payload) => {
        updateCalls.push({ id, payload });
        return { id, ...payload };
      },
    };

    const result = await runFixEvolutionInstanceNames({
      apply: true,
      instancesRepository,
      listEvolutionInstances: async () => ({
        data: [
          { name: "linaestimulobusiness", ownerJid: null },
          { name: "estimuloMvp", ownerJid: null },
        ],
      }),
      evolutionConfig: { baseUrl: "http://evolution.local" },
      log: noopLog,
    });

    assert.equal(updateCalls.length, 1, "so a instancia divergente deve ser atualizada");
    assert.deepEqual(updateCalls[0], {
      id: "instance-1",
      payload: { instance_name: "linaestimulobusiness", last_sync_error: null },
    });
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].instance.id, "instance-1");

    // A instancia ja correta (estimuloMvp) fica de fora de tudo.
    assert.equal(updateCalls.some((call) => call.id === "instance-2"), false);
  }

  // ---------- instancia que nao existe mais na Evolution: nunca tenta corrigir, mesmo com --apply ----------
  {
    const updateCalls = [];
    const instancesRepository = {
      findAll: async () => [{ id: "instance-orfa", instance_name: "numeroDesativado", phone_number: null }],
      update: async (...args) => {
        updateCalls.push(args);
        return {};
      },
    };

    const result = await runFixEvolutionInstanceNames({
      apply: true,
      instancesRepository,
      listEvolutionInstances: async () => ({ data: [] }),
      evolutionConfig: { baseUrl: "http://evolution.local" },
      log: noopLog,
    });

    assert.equal(updateCalls.length, 0, "instancia ausente na Evolution nao deve ser 'corrigida' as cegas");
    assert.equal(result.missing.length, 1);
    assert.equal(result.mismatches.length, 0);
  }

  console.log("fix-evolution-instance-names tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
