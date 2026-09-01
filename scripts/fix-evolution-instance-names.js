#!/usr/bin/env node
// Diagnostica e corrige divergencia entre `whatsapp_instances.instance_name`
// (nosso banco) e o nome real da instancia na Evolution API.
//
// Sintoma: a tela de Grupos mostra o triangulo de alerta com
// `HTTP 404: The "<nome>" instance does not exist` num numero que esta
// conectado e funcionando. Todas as rotas da Evolution levam o nome no path,
// entao um nome divergente quebra sync E disparo daquele numero.
//
//   node scripts/fix-evolution-instance-names.js          # so mostra (dry-run)
//   node scripts/fix-evolution-instance-names.js --apply  # grava a correcao
//
// O sync e o envio ja se corrigem sozinhos ao encontrar o 404; este script
// serve para inspecionar/consertar sem esperar a proxima passada.
require("dotenv").config({ quiet: true });

const instancesRepositoryDefault = require("../src/repositories/whatsapp-instances.repository");
const { listEvolutionInstances: listEvolutionInstancesDefault } = require("../src/services/evolution-instances");
const { extractInstanceEntries, resolveRemoteInstanceName } = require("../src/services/evolution-instance-resolver");
const { evolutionConfig: evolutionConfigDefault } = require("../src/config/evolution");

// Nucleo testavel: recebe as dependencias que tocam a rede/o banco por
// injecao (mesmo padrao de scripts/test-supabase-connection.js), para que o
// dry-run e o --apply possam ser verificados em teste sem uma Evolution API
// nem um Supabase reais - importante porque este e um script que ESCREVE em
// dados de producao quando chamado com --apply.
async function runFixEvolutionInstanceNames(options = {}) {
  const apply = options.apply === true;
  const instancesRepository = options.instancesRepository || instancesRepositoryDefault;
  const listEvolutionInstances = options.listEvolutionInstances || listEvolutionInstancesDefault;
  const evolutionConfig = options.evolutionConfig || evolutionConfigDefault;
  const log = options.log || console.log;

  log(`Evolution API: ${evolutionConfig.baseUrl}`);

  const response = await listEvolutionInstances({});
  const remoteEntries = extractInstanceEntries(response && response.data);

  log(`\nInstancias na Evolution (${remoteEntries.length}):`);
  for (const entry of remoteEntries) {
    log(`  - ${JSON.stringify(entry.name)}  ${entry.ownerJid || "(sem numero)"}`);
  }

  const localInstances = await instancesRepository.findAll();

  log(`\nInstancias no banco (${localInstances.length}):`);

  const mismatches = [];
  const missing = [];
  const applied = [];

  for (const instance of localInstances) {
    const remoteName = resolveRemoteInstanceName(instance, remoteEntries);
    const local = JSON.stringify(instance.instance_name);

    if (remoteName === instance.instance_name) {
      log(`  OK        ${local}`);
      continue;
    }

    if (!remoteName) {
      log(`  AUSENTE   ${local} - nao existe na Evolution (recadastre ou desative este numero)`);
      missing.push(instance);
      continue;
    }

    mismatches.push({ instance, remoteName });
    log(`  DIVERGE   ${local} -> ${JSON.stringify(remoteName)}`);

    if (apply) {
      await instancesRepository.update(instance.id, { instance_name: remoteName, last_sync_error: null });
      applied.push({ instance, remoteName });
      log(`            corrigido no banco`);
    }
  }

  if (mismatches.length && !apply) {
    log(`\n${mismatches.length} divergencia(s). Rode com --apply para corrigir.`);
  } else if (!mismatches.length) {
    log(`\nNenhuma divergencia de nome.`);
  }

  return { remoteEntries, localInstances, mismatches, missing, applied };
}

async function main() {
  const apply = process.argv.includes("--apply");
  await runFixEvolutionInstanceNames({ apply });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nFalhou: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { runFixEvolutionInstanceNames };
