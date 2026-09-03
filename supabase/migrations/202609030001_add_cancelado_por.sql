-- Quem cancelou.
--
-- A migration 202609020002 respondeu "o QUE cancelou" (cancelado_origem:
-- usuario | atraso | campanha_cancelada | sistema), mas nao "QUEM". A diferenca
-- apareceu na investigacao do cancelamento de 03/09/2026: 34 envios da campanha
-- "Divulgacao FIRME 1" foram cancelados as 12:16:07Z e o banco sabia dizer que
-- partiu do painel, nunca de qual conta - porque `POST /campaigns/:id/cancel`
-- nem chegava a ler `req.user` (o controller ignorava a sessao, ao contrario de
-- confirmDispatch e dos disparos pontuais, que ja gravavam
-- logs.usuario_responsavel_id).
--
-- Duas colunas, uma em cada ponta do cancelamento:
--
--   campaigns.cancelado_por - a conta que clicou em "Cancelar campanha";
--   logs.cancelado_por      - a mesma conta, propagada para cada envio que a
--                             cascata cancelou, para o relatorio responder por
--                             linha sem precisar voltar na campanha.
--
-- Fica NULL em todo cancelamento automatico (trava de atraso, worker), onde nao
-- existe usuario por tras da acao - a resposta certa ali e "ninguem", nao um
-- nome inventado. Tambem fica NULL em todo cancelamento anterior a esta
-- migration: o dado nunca foi gravado e nao ha como reconstruir sem chutar.
--
-- ON DELETE SET NULL (e nao o NO ACTION padrao) pelo mesmo motivo do incidente
-- corrigido em 202609010001: uma FK sem ON DELETE em tabela de historico trava
-- a remocao do registro pai. Remover um usuario no painel nao pode falhar
-- porque ele cancelou uma campanha em algum momento.
ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS cancelado_por uuid REFERENCES public.app_users(id) ON DELETE SET NULL;

ALTER TABLE public.logs
ADD COLUMN IF NOT EXISTS cancelado_por uuid REFERENCES public.app_users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.campaigns.cancelado_por IS
    'Conta que cancelou a campanha no painel. Nula em cancelamento automatico e em cancelamentos anteriores a 202609030001.';
COMMENT ON COLUMN public.logs.cancelado_por IS
    'Conta responsavel pelo cancelamento deste envio. Nula quando o cancelamento foi automatico (trava de atraso, worker).';
