-- Backfill: campanha cancelada precisa ter ativo = false.
--
-- cancelCampaign (src/services/campaigns.service.js) gravava apenas
-- { status: "cancelado" } e deixava `ativo` como estava - true. A checagem de
-- conflito de janela (campaigns.repository.listActiveOverlappingWindow, usada
-- por assertNoCampaignWindowConflict) filtra por `ativo = true` e NAO olha o
-- status, entao toda campanha cancelada continuava disputando sua janela: um
-- disparo pontual novo nos mesmos grupos e no mesmo horario falhava com 409
-- "Ja existe campanha ativa no mesmo periodo", apontando para uma campanha que
-- o usuario ja havia cancelado. Como a janela nunca "vence" nessa query (a
-- comparacao e' start < fim_novo AND fim > inicio_novo, sem recorte por data
-- atual), o bloqueio era permanente para aquele horario.
--
-- O service ja foi corrigido para gravar ativo = false junto com o status. Esta
-- migration conserta as linhas gravadas antes disso (5 em producao em
-- 2026-09-01), que continuariam bloqueando suas janelas indefinidamente.
--
-- Idempotente e restrito a status = 'cancelado': nao toca campanha pausada
-- (reversivel via resumeCampaign, precisa seguir ativa) nem programada.
UPDATE public.campaigns
    SET ativo = false
    WHERE status = 'cancelado'
      AND ativo = true;
