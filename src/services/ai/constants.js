const DEFAULT_TRANSCRIPTION_PROMPT =
  "Transcreva fielmente todo o audio falado deste video em portugues brasileiro. Retorne apenas a transcricao em texto corrido. Preserve nomes proprios, termos tecnicos e numeros. Nao resuma, nao interprete, nao adicione comentarios, nao use markdown e nao inclua timestamps.";

const DEFAULT_CAPTION_GENERATION_PROMPT =
  "Crie uma legenda curta em portugues brasileiro para enviar junto com este video. Use apenas fatos presentes na transcricao, nao invente informacoes e retorne somente a legenda.";

const DEFAULT_CAPTION_REVIEW_PROMPT =
  "Voce e um agente de revisao factual de legendas. Compare a legenda com a transcricao do video. Aprove apenas se a legenda for coerente com a transcricao, representar corretamente o conteudo e nao contiver informacoes incorretas, inventadas ou incompativeis. Responda somente JSON valido no formato {\"approved\":true|false,\"reason\":\"motivo curto\"}.";

module.exports = {
  DEFAULT_CAPTION_GENERATION_PROMPT,
  DEFAULT_CAPTION_REVIEW_PROMPT,
  DEFAULT_TRANSCRIPTION_PROMPT,
};
