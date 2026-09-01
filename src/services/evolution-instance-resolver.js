const { listEvolutionInstances } = require("./evolution-instances");

// Nome da instancia na Evolution vs. nome guardado aqui.
//
// A Evolution identifica a instancia pelo nome DELA, que vai cru no path de
// toda rota (`/group/fetchAllGroups/:instance`, `/message/sendText/:instance`,
// ...). Nos gravamos em `whatsapp_instances.instance_name` o texto que o
// usuario digitou ao cadastrar o numero e nunca conferimos contra o que a
// Evolution de fato registrou - `createEvolutionInstance` descarta o nome que
// vem na resposta do `POST /instance/create`.
//
// Quando os dois divergem (acento/espaco normalizado pela Evolution, instancia
// recriada com outro nome, rename direto no manager), todas as chamadas daquele
// numero passam a responder
// `404 The "<nome>" instance does not exist` - mesmo com o numero conectado e
// funcionando. Era o caso de "Lina Estimulo Business" e
// "Estimulo Sophia de Freitas", ambos com acento, enquanto "estimulo-novo"
// (so ASCII) sincronizava normalmente.
//
// Este modulo resolve o nome real consultando `GET /instance/fetchInstances`,
// que e a lista autoritativa da Evolution, e casando por candidatos cada vez
// mais frouxos - nunca por adivinhacao: se nada casar sem ambiguidade, devolve
// null e quem chamou mantem o comportamento atual (falhar com o 404).

// A Evolution ja mudou o formato dessa resposta entre versoes (`name` na v2,
// `instanceName` antes, as vezes aninhado em `instance`), entao normalizamos.
function extractInstanceEntries(data) {
  const list = Array.isArray(data) ? data : data && Array.isArray(data.instances) ? data.instances : data ? [data] : [];

  return list
    .map((raw) => {
      const entry = raw && raw.instance ? raw.instance : raw;

      if (!entry || typeof entry !== "object") {
        return null;
      }

      const name = entry.name || entry.instanceName || entry.instance_name || null;

      if (!name) {
        return null;
      }

      return {
        name: String(name),
        ownerJid: entry.ownerJid || entry.owner || null,
      };
    })
    .filter(Boolean);
}

// Remove acentos e reduz separadores para comparar "Lina Estímulo Business",
// "Lina Estimulo Business" e "lina-estimulo-business" como o mesmo nome.
function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .trim();
}

// Converte o nome digitado pelo usuario para o formato que vira `instance_name`
// de fato: camelCase, minusculo na primeira palavra, sem espaco/acento/pontuacao.
// A Evolution usa esse texto cru no path de toda rota
// (`/group/fetchAllGroups/:instance`, `/message/sendText/:instance`, ...), entao
// qualquer caractere que ela normalize por conta propria (o caso observado com
// "Lina Est\u00edmulo Business" -> 404 depois de criada) faz o nosso banco divergir
// do nome real - aplicar a mesma normalizacao no cadastro evita o 404 em vez de
// so recupera-lo depois (resolveInstanceNames continua existindo como rede de
// seguranca para as instancias cadastradas antes desta regra).
function toSafeInstanceName(value) {
  const withoutAccents = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const words = withoutAccents.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  if (words.length === 0) {
    return "";
  }

  return words
    .map((word, index) => {
      const lower = word.toLowerCase();

      return index === 0 ? lower : lower[0].toUpperCase() + lower.slice(1);
    })
    .join("");
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

// Devolve o nome real na Evolution para uma instancia nossa, ou null quando nao
// da para decidir com seguranca. A ordem importa: casar pelo numero conectado e
// mais forte que casar por texto, porque o telefone e o mesmo mesmo depois de um
// rename qualquer.
function resolveRemoteInstanceName(instance, remoteEntries) {
  if (!instance || !instance.instance_name || !Array.isArray(remoteEntries) || remoteEntries.length === 0) {
    return null;
  }

  const localName = String(instance.instance_name);

  // 1. Nome identico: nada a corrigir.
  if (remoteEntries.some((entry) => entry.name === localName)) {
    return localName;
  }

  // 2. Mesmo numero de telefone conectado. E o sinal mais confiavel de que a
  //    instancia remota e esta mesma, so com outro nome.
  const localPhone = digitsOnly(instance.phone_number);

  if (localPhone) {
    const byPhone = remoteEntries.filter((entry) => {
      const remotePhone = digitsOnly(entry.ownerJid);

      return remotePhone && remotePhone === localPhone;
    });

    if (byPhone.length === 1) {
      return byPhone[0].name;
    }
  }

  // 3. Nome equivalente ignorando acento/caixa/separador. So aceita quando um
  //    unico candidato casa - dois candidatos equivalentes significam que nao da
  //    para saber qual e o certo, e chutar mandaria mensagem pelo numero errado.
  const normalizedLocal = normalizeName(localName);
  const byName = remoteEntries.filter((entry) => normalizeName(entry.name) === normalizedLocal);

  if (byName.length === 1) {
    return byName[0].name;
  }

  return null;
}

// Busca a lista remota uma unica vez e resolve varias instancias contra ela.
// `listInstances` e injetavel para teste.
async function resolveInstanceNames(instances, options = {}) {
  const listInstances = options.listEvolutionInstances || listEvolutionInstances;
  const response = await listInstances({ config: options.config });
  const remoteEntries = extractInstanceEntries(response && response.data !== undefined ? response.data : response);

  return instances.map((instance) => ({
    instance,
    remoteName: resolveRemoteInstanceName(instance, remoteEntries),
  }));
}

module.exports = {
  extractInstanceEntries,
  normalizeName,
  resolveInstanceNames,
  resolveRemoteInstanceName,
  toSafeInstanceName,
};
