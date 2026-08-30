-- Suporte para "apagar registros do relatorio por periodo": a acao nunca
-- remove linhas de verdade (perderia evidencia de disparo/erro para auditoria
-- e violaria a FK logs.campaign_id -> campaigns em cascade). hidden_at marca
-- quando o registro foi retirado do relatorio; NULL = visivel normalmente.
-- campaigns tambem recebe a coluna porque, quando todos os logs de uma
-- campanha ficam ocultos, a campanha some das listagens junto (ver
-- dispatch-logs.service.js hideByDateRange).
ALTER TABLE public.logs
ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_logs_hidden_at ON public.logs (hidden_at) WHERE hidden_at IS NULL;
