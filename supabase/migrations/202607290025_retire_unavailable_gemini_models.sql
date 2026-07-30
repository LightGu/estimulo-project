-- A API do Gemini passou a responder 404 "This model models/gemini-2.5-flash-lite
-- is no longer available to new users" para os modelos 2.5 Flash / 2.5 Flash-Lite.
-- Como settings.ai_agents guardava exatamente esses modelos (default da migration
-- 202607290015), toda a cascata de fallback dos agentes de transcricao, geracao e
-- revisao de legenda era composta de modelos mortos: a legenda ficava pronta e o
-- envio da campanha falhava com "Falha ao gerar texto com Gemini".
--
-- Esta migration troca o default da coluna e reescreve as configuracoes ja salvas
-- para modelos verificados na API, terminando nos aliases "-latest", que continuam
-- validos quando o Google retira uma versao numerada. Prompts customizados e
-- modelos ainda validos escolhidos pelo usuario sao preservados.

ALTER TABLE public.settings
    ALTER COLUMN ai_agents SET DEFAULT '{
      "transcription": {
        "models": ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"]
      },
      "caption_generation": {
        "models": ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-flash-latest"],
        "prompt": null
      },
      "caption_review": {
        "models": ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-lite-latest"],
        "prompt": null
      }
    }'::jsonb;

-- Helper temporario: remove os modelos retirados da lista salva e completa com os
-- modelos padrao. O "completar" importa: sem ele uma configuracao como
-- ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-2.5-flash-lite"] sobraria com um
-- unico modelo e qualquer 429 de cota diaria voltaria a derrubar o envio, agora sem
-- nenhum fallback. Os modelos escolhidos pelo usuario continuam tendo prioridade.
CREATE OR REPLACE FUNCTION public.strip_retired_gemini_models(
    stored_models jsonb,
    fallback_models jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(jsonb_agg(unique_models.value ORDER BY unique_models.priority), '[]'::jsonb)
    FROM (
        SELECT DISTINCT ON (candidate.value) candidate.value, candidate.priority
        FROM (
            -- Modelos salvos que sobreviveram, na ordem original.
            SELECT kept.value, kept.ord AS priority
            FROM jsonb_array_elements_text(COALESCE(stored_models, '[]'::jsonb))
                WITH ORDINALITY AS kept(value, ord)
            WHERE kept.value NOT IN (
                'gemini-2.5-flash',
                'gemini-2.5-flash-lite',
                'gemini-2.5-flash-lite-preview-09-2025',
                'gemini-1.5-flash',
                'gemini-1.5-flash-8b',
                'gemini-1.5-pro',
                'gemini-2.0-flash-exp'
            )
            UNION ALL
            -- Padroes entram depois, so completando o que faltou.
            SELECT defaults.value, 1000 + defaults.ord
            FROM jsonb_array_elements_text(fallback_models)
                WITH ORDINALITY AS defaults(value, ord)
        ) AS candidate
        ORDER BY candidate.value, candidate.priority
    ) AS unique_models;
$$;

UPDATE public.settings s
SET ai_agents = COALESCE(s.ai_agents, '{}'::jsonb) || jsonb_build_object(
        'transcription',
        COALESCE(s.ai_agents -> 'transcription', '{}'::jsonb) || jsonb_build_object(
            'models',
            public.strip_retired_gemini_models(
                s.ai_agents -> 'transcription' -> 'models',
                '["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"]'::jsonb
            )
        ),
        'caption_generation',
        COALESCE(s.ai_agents -> 'caption_generation', '{}'::jsonb) || jsonb_build_object(
            'models',
            public.strip_retired_gemini_models(
                s.ai_agents -> 'caption_generation' -> 'models',
                '["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-flash-latest"]'::jsonb
            )
        ),
        'caption_review',
        COALESCE(s.ai_agents -> 'caption_review', '{}'::jsonb) || jsonb_build_object(
            'models',
            public.strip_retired_gemini_models(
                s.ai_agents -> 'caption_review' -> 'models',
                '["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-lite-latest"]'::jsonb
            )
        )
    );

DROP FUNCTION IF EXISTS public.strip_retired_gemini_models(jsonb, jsonb);
