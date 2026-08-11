require("dotenv").config({ quiet: true });

// Configuracoes centralizadas da Evolution API usadas pelo wrapper de entrega.
const evolutionConfig = {
  // URL base da API, sem endpoint especifico.
  baseUrl: process.env.EVOLUTION_API_URL || "http://localhost:8080",
  // Chave enviada no header `apikey` em todas as requisicoes.
  apiKey: process.env.EVOLUTION_API_KEY || "change-me",
  // Instancia do WhatsApp criada/conectada na Evolution API.
  instanceName: process.env.EVOLUTION_INSTANCE_NAME || "estimulo-mvp",
  // Tempo maximo de espera por resposta antes de considerar falha (envio de texto).
  timeoutMs: Number(process.env.EVOLUTION_API_TIMEOUT_MS || 15000),
  // Midia (video/imagem/audio/documento) e enviada em base64 no corpo da requisicao;
  // a Evolution API demora mais para decodificar/processar/entregar, entao usa um
  // timeout proprio, maior, para evitar falso-negativo (video chega no grupo mas o
  // request ja tinha estourado o timeout do lado do backend).
  mediaTimeoutMs: Number(process.env.EVOLUTION_API_MEDIA_TIMEOUT_MS || 180000),
  // Tamanho maximo do corpo da requisicao aceito pela Evolution API. A Evolution
  // registra `express.urlencoded({ limit: '136mb' })` e `express.json({ limit: '136mb' })`
  // no bootstrap (valor fixo no bundle, sem variavel de ambiente), entao qualquer
  // corpo acima disso e recusado pelo body-parser com HTTP 413 antes de chegar em
  // qualquer rota. Como midia vai em base64 (+33% sobre os bytes do arquivo), um
  // video de ~102 MB ja estoura o limite. Mantemos o numero aqui para poder barrar
  // o envio antes de gastar upload, e para saber quando recomprimir o video.
  maxMediaPayloadBytes: Number(process.env.EVOLUTION_API_MAX_MEDIA_PAYLOAD_BYTES || 136 * 1024 * 1024),
};

// Confirmacao de entrega: a resposta HTTP da Evolution so diz que ela aceitou a
// mensagem, nunca que o WhatsApp entregou. Quem sabe a diferenca e o ACK
// (PENDING -> SERVER_ACK -> DELIVERY_ACK -> READ) que a Evolution grava na
// coluna `status` da tabela `Message` do banco dela. Como a rota
// `POST /chat/findMessages` da v2.3.7 nao devolve esse campo (conferido contra a
// instancia real: o `select` do Prisma omite `status`, e `MessageUpdate` vem
// vazio ate para mensagens de grupo ja lidas), o unico jeito de ler o ACK sem
// depender de webhook e consultar o Postgres da propria Evolution. As variaveis
// EVOLUTION_DB_* ja existiam para o Compose; aqui elas passam a ser usadas
// tambem como fonte de verdade da entrega.
const deliveryConfirmationConfig = {
  // Desligar volta ao comportamento antigo (aceite = "enviado"). Existe como
  // valvula de escape para instalacoes em que o banco da Evolution nao e
  // alcancavel pela aplicacao.
  enabled: String(process.env.DELIVERY_CONFIRMATION_ENABLED || "true").toLowerCase() !== "false",
  // Quanto tempo esperar o ACK antes de considerar o envio nao confirmado.
  timeoutMs: Number(process.env.DELIVERY_CONFIRMATION_TIMEOUT_MS || 90000),
  // Janela separada, curta, para destino de grupo (@g.us). O WhatsApp nao devolve
  // ACK por mensagem que a gente manda em grupo: conferido contra a instancia
  // real, as 18 mensagens enviadas pela API para grupo ficaram em `PENDING` para
  // sempre e nenhuma gerou linha em `MessageUpdate`, enquanto as 352 linhas de
  // ACK existentes (DELIVERY_ACK/READ/PLAYED) eram todas de conversa 1-a-1.
  // Esperar os 90s cheios por um ACK que nunca vem so ocupava o worker e deixava
  // o relatorio 90s atrasado; a janela curta ainda da tempo de a Evolution
  // persistir a mensagem (que e a evidencia que sobra) e de um ACK de erro
  // aparecer.
  groupTimeoutMs: Number(process.env.DELIVERY_CONFIRMATION_GROUP_TIMEOUT_MS || 15000),
  pollIntervalMs: Number(process.env.DELIVERY_CONFIRMATION_POLL_INTERVAL_MS || 5000),
  databaseUrl: process.env.EVOLUTION_DB_URL || null,
  databaseHost: process.env.EVOLUTION_DB_HOST || "localhost",
  databasePort: Number(process.env.EVOLUTION_DB_PORT || 5433),
  databaseUser: process.env.EVOLUTION_DB_USER || "evolution",
  databasePassword: process.env.EVOLUTION_DB_PASSWORD || "",
  databaseName: process.env.EVOLUTION_DB_NAME || "evolution",
};

module.exports = {
  deliveryConfirmationConfig,
  evolutionConfig,
};
