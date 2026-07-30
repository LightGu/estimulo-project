const VALIDATION_ERROR_PATTERNS = [
  "Selecione ao menos um grupo",
  "Informe um texto ou um link de conteudo",
  "window_start e window_end",
  "Grupo(s) nao encontrado(s)",
  "Grupo(s) sem evolution_group_id",
  "Grupo(s) sem classificacao (segmento)",
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

function createMensagensController(dependencies = {}) {
  const mensagensService = dependencies.mensagensService;

  async function dispatch(req, res) {
    try {
      const result = await mensagensService.dispatchAdHoc(req.body || {});

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (isValidationError(message)) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function schedule(req, res) {
    try {
      const result = await mensagensService.scheduleAdHoc(req.body || {});

      return res.status(202).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (isValidationError(message)) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return { dispatch, schedule };
}

module.exports = createMensagensController;
