-- Ate aqui, nenhum registro em `logs` sabia quem disparou aquele envio - so o
-- pipeline automatico (campanha/fila) ficava rastreado. Para disparos
-- acionados diretamente no painel (confirmar campanha, disparo pontual
-- imediato ou agendado), guardamos o usuario logado que iniciou a acao.
-- Fica nulo para logs criados por jobs de fila sem contexto HTTP (ex.: envio
-- automatico de trilha), onde nao existe um usuario responsavel.
ALTER TABLE public.logs
ADD COLUMN IF NOT EXISTS usuario_responsavel_id uuid REFERENCES public.app_users(id);
