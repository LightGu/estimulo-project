DROP TRIGGER IF EXISTS trg_campaigns_updated_at ON public.campaigns;

DELETE FROM public.group_video_progress progress
USING public.logs log
WHERE progress.group_id = log.group_id
  AND progress.video_id = log.video_id
  AND log.status = 'erro'
  AND NOT EXISTS (
      SELECT 1
      FROM public.logs sent_log
      WHERE sent_log.campaign_id = log.campaign_id
        AND sent_log.group_id = log.group_id
        AND sent_log.video_id = log.video_id
        AND sent_log.status = 'enviado'
  );

UPDATE public.campaigns campaign
SET ativo = false
WHERE EXISTS (
    SELECT 1
    FROM public.logs log
    WHERE log.campaign_id = campaign.id
      AND log.status = 'erro'
);

UPDATE public.campaigns campaign
SET data_envio = NULL,
    horario_envio = NULL
WHERE NOT EXISTS (
    SELECT 1
    FROM public.logs log
    WHERE log.campaign_id = campaign.id
      AND log.status = 'enviado'
);
