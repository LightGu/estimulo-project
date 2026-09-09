/*
  Identificador de correlacao de UM envio, propagado por todas as camadas.

  O PROBLEMA QUE ELE RESOLVE.

  O logging estruturado do projeto e' bom - JSON com `event` em todos os
  estagios - mas nao havia uma chave que atravessasse o caminho inteiro.
  Correlacionar exigia reconstruir o trio campanha/grupo/video a partir de
  campos que MUDAM DE SIGNIFICADO entre camadas:

    job de dispatch:      group_id = JID da Evolution ("...@g.us")
                          progress_group_id = PK do Postgres
    log de dispatch:      group_id = PK do Postgres   (invertido!)
    dispatch-consistency: log_id, que so existe DEPOIS do claim
    delivery-confirmation: provider_message_id, que so existe DEPOIS do aceite

  Ou seja: nenhum campo comum aos tres, e os dois identificadores mais uteis
  aparecem tarde. Investigar "esse grupo nao recebeu ontem as 14h" virava juntar
  linhas por proximidade temporal em sete containers. Foi por isso que fez
  sentido, na epoca, criar o rastreio ad hoc TRACE_ORPHAN_DISPATCH_LOGS
  escrevendo num .jsonl local - sintoma de que a observabilidade normal nao
  respondia.

  DESENHO.

  Deterministico, e nao aleatorio: o mesmo envio produz o mesmo ref onde quer
  que seja recalculado. Isso importa porque o log e o job sao criados por
  processos diferentes (a confirmacao na API cria o log; o trigger cria o job) e
  precisam chegar ao MESMO valor sem se falarem.

  Curto o suficiente para caber numa linha de log e ser digitado num grep, e
  legivel o bastante para dizer de que envio se trata antes de consultar o banco.

  NEM `retry_count` NEM o horario entram na chave, ao contrario do que acontece
  no jobId - e a diferenca e' proposital. O jobId precisa distinguir TENTATIVAS e
  HORARIOS, porque a BullMQ descartaria em silencio um add() que colidisse com um
  jobId existente. O ref responde outra pergunta: "que envio e' este?". E o envio
  e' o mesmo quando a tentativa muda (markRetrying reaproveita a MESMA linha em
  `logs`) e quando o horario muda (resumeCampaign desloca o horario planejado;
  ensurePendingDispatchLogs o sincroniza com o do job). Se qualquer um dos dois
  compusesse a chave, a coluna do banco e os eventos do worker apontariam para
  refs diferentes para o mesmo envio - e o grep que justifica o ref existir nao
  acharia as duas pontas.

  A tentativa continua visivel no log pelo campo `retry_count`, registrado ao
  lado, e o horario por `scheduled_at`.
*/

// Prefixo curto e estavel de um UUID. 8 hex chars = 4 bilhoes de combinacoes,
// suficiente para nao colidir dentro de uma campanha, e o ref nunca e' usado
// como chave de unicidade - so para correlacionar.
function shortId(value) {
  const text = String(value || "").replace(/-/g, "");

  if (!text) {
    return "0";
  }

  return text.slice(0, 8).toLowerCase();
}

function resolveEpochMs(scheduledAt) {
  const parsed = scheduledAt ? Date.parse(scheduledAt) : Number.NaN;

  return Number.isFinite(parsed) ? parsed : 0;
}

/*
  Monta o ref de um envio de video.

  Formato: d:<campanha>:<grupo>:<video>
  Exemplo: d:11111111:22222222:33333333

  O HORARIO NAO ENTRA, e a razao e' a mesma que tirou o retry_count: o ref
  identifica o ENVIO, e o horario do envio muda sem que o envio mude.
  `resumeCampaign` desloca horario_envio_planejado pela duracao da pausa, e
  `ensurePendingDispatchLogs` sincroniza o horario do log com o do job quando o
  jitter e' recalculado. Se o horario compusesse a chave, o log gravado na
  confirmacao e os eventos do worker depois de um reagendamento ficariam com
  refs DIFERENTES para o mesmo envio - e um grep pelo ref do relatorio nao
  acharia as linhas do worker, que e' exatamente o uso que justifica existir.

  Ancorado no trio campanha/grupo/video, o ref passa a coincidir com a
  identidade que o banco ja garante (idx_logs_trio_ativo, migration
  202609070002): no maximo um envio ativo por trio. Duas execucoes de uma
  campanha recorrente para o mesmo trio nao podem coexistir como linhas ativas,
  entao nao ha ambiguidade a resolver.
*/
function buildDispatchRef(params = {}) {
  const { campaignId, campaign_id, groupId, group_id, videoId, video_id } = params;

  return [
    "d",
    shortId(campaignId ?? campaign_id),
    shortId(groupId ?? group_id),
    shortId(videoId ?? video_id),
  ].join(":");
}

/*
  Monta o ref de um envio de mensagem pontual (sem video).

  Formato proprio ("m:") para que o prefixo diga, na leitura, de qual das duas
  filas aquele envio veio - a pergunta que sempre se faz primeiro ao abrir um
  log.
*/
function buildMensagensRef(params = {}) {
  const { groupId, group_id, internalGroupId, internal_group_id, scheduledAt, scheduled_at, dispatchLogId, dispatch_log_id } =
    params;

  const logId = dispatchLogId ?? dispatch_log_id;

  if (logId) {
    return `m:log:${shortId(logId)}`;
  }

  return [
    "m",
    shortId(internalGroupId ?? internal_group_id ?? groupId ?? group_id),
    resolveEpochMs(scheduledAt ?? scheduled_at),
  ].join(":");
}

module.exports = {
  buildDispatchRef,
  buildMensagensRef,
  shortId,
};
