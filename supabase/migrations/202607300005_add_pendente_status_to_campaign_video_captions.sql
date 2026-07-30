-- A geracao de legendas de uma campanha e sequencial: um video por vez. Mas todas
-- as linhas nascem juntas (a tela da Etapa 2 usa a contagem de linhas como total
-- esperado), e nascer com status 'processando' fazia a tela mostrar todos os
-- videos como "Processando" ao mesmo tempo -- como se houvesse uma requisicao por
-- video em paralelo. Com 'pendente' a fila fica visivel: quem ainda nao comecou
-- aparece na fila e so a linha efetivamente em geracao vira 'processando'.

ALTER TABLE public.campaign_video_captions
    DROP CONSTRAINT IF EXISTS campaign_video_captions_status_check;

ALTER TABLE public.campaign_video_captions
    DROP CONSTRAINT IF EXISTS chk_campaign_video_captions_status;

ALTER TABLE public.campaign_video_captions
    ADD CONSTRAINT chk_campaign_video_captions_status
    CHECK (status IN ('pendente', 'processando', 'gerado', 'erro'));

ALTER TABLE public.campaign_video_captions
    ALTER COLUMN status SET DEFAULT 'pendente';
