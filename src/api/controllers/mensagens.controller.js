const VALIDATION_ERROR_PATTERNS = [
  "Selecione ao menos um grupo",
  "Informe um texto ou um link de conteudo",
  "window_start e window_end",
  "Grupo(s) nao encontrado(s)",
  "Grupo(s) sem evolution_group_id",
  "Grupo(s) sem classificacao (segmento)",
  "Grupo(s) sem vinculo com todos os numeros de WhatsApp ativos",
  "groups deve conter ao menos um grupo",
  "cada item de groups deve informar group_id",
  "jitter_delay_min_ms",
  "jitter_delay_max_ms",
  "janela da campanha nao comporta",
  "e obrigatorio",
  "deve ser uma data valida",
  "deve ser uma data/hora futura",
  "deve usar o formato HH:mm",
];

function isValidationError(message) {
  return VALIDATION_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

// Multipart nao serializa arrays/objetos nativamente: os campos escalares do
// form (titulo, tipo, group_ids, texto, window_start/end, jitter_delay_*)
// chegam em req.body como strings; group_ids chega como uma string JSON.
function parseMultipartBody(body = {}) {
  let groupIds = body.group_ids;

  if (typeof groupIds === "string") {
    try {
      groupIds = JSON.parse(groupIds);
    } catch (error) {
      groupIds = [];
    }
  }

  return { ...body, group_ids: Array.isArray(groupIds) ? groupIds : [] };
}

// O arquivo fica so em memoria (multer memoryStorage) - convertido para base64
// aqui, na hora de montar o payload, e nunca gravado em disco ou no banco.
function buildContentFromUploadedFile(file) {
  if (!file) {
    return {};
  }

  return {
    content: {
      base64: file.buffer.toString("base64"),
      mimeType: file.mimetype,
      fileName: file.originalname,
      type: file.mimetype && file.mimetype.startsWith("video/") ? "video" : "image",
    },
  };
}

// Contrato de erro compartilhado por dispatch/schedule e suas variantes com
// midia: 409 com conflicts para janela ocupada por campanha de video, 400 para
// erro de validacao conhecido, 500 generico para o resto.
function respondWithError(res, error) {
  const message = error?.message || "Internal server error";

  if (error?.code === "CAMPAIGN_WINDOW_CONFLICT") {
    return res.status(409).json({ error: message, conflicts: error.conflicts });
  }

  // Todos os numeros pausados: nao e erro de validacao do que o usuario digitou,
  // e um estado da configuracao que ele mesmo pode resolver despausando um
  // numero - por isso 409 com a mensagem original, e nao um 500 opaco.
  if (error?.code === "ALL_INSTANCES_PAUSED") {
    return res.status(409).json({ error: message });
  }

  if (isValidationError(message)) {
    return res.status(400).json({ error: message });
  }

  return res.status(500).json({ error: "Internal server error" });
}

function createMensagensController(dependencies = {}) {
  const mensagensService = dependencies.mensagensService;

  async function dispatch(req, res) {
    try {
      const result = await mensagensService.dispatchAdHoc(req.body || {}, { userId: req.user && req.user.id });

      return res.status(200).json(result);
    } catch (error) {
      return respondWithError(res, error);
    }
  }

  async function schedule(req, res) {
    try {
      const result = await mensagensService.scheduleAdHoc(req.body || {}, { userId: req.user && req.user.id });

      return res.status(202).json(result);
    } catch (error) {
      return respondWithError(res, error);
    }
  }

  async function dispatchWithMedia(req, res) {
    try {
      const payload = { ...parseMultipartBody(req.body), ...buildContentFromUploadedFile(req.file) };
      const result = await mensagensService.dispatchAdHoc(payload, { userId: req.user && req.user.id });

      return res.status(200).json(result);
    } catch (error) {
      return respondWithError(res, error);
    }
  }

  async function scheduleWithMedia(req, res) {
    try {
      const payload = { ...parseMultipartBody(req.body), ...buildContentFromUploadedFile(req.file) };
      const result = await mensagensService.scheduleAdHoc(payload, { userId: req.user && req.user.id });

      return res.status(202).json(result);
    } catch (error) {
      return respondWithError(res, error);
    }
  }

  return { dispatch, schedule, dispatchWithMedia, scheduleWithMedia };
}

module.exports = createMensagensController;
