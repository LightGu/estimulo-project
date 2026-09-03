# Estimulo Project — guia para Claude Code

MVP de disparo de conteudos em grupos de WhatsApp (Node/Express + BullMQ/Redis + Evolution API + Supabase). Visao geral completa: `README.md`. Deploy detalhado: `docs/DEPLOY_ORACLE.md`.

## Deploy — "faça deploy agora"

Quando o usuario pedir para fazer deploy (ex.: "faça deploy agora", "sobe pra deploy"), sem mais detalhes, significa: **pegar o que esta commitado na branch `main` do GitHub e colocar no ar na VM de producao**. Faca sempre nesta ordem, sem pular passos:

1. **Checar se ha algo novo em `origin/main`:**
   ```bash
   git fetch origin
   git log --oneline HEAD..origin/main
   ```
   Se vazio, nao ha nada para deployar — avise o usuario e pare aqui.

2. **Atualizar o repo local** (fast-forward; se nao for possivel, pare e avise — nao force):
   ```bash
   git merge --ff-only origin/main
   ```

3. **Checar se vieram migrations novas** em `supabase/migrations/` (compare a lista antes/depois do merge, ou `git diff --stat` do passo 1). Elas **nao sao aplicadas automaticamente** — o projeto nao tem CLI do Supabase linkado. No fim do deploy, liste o SQL de cada migration nova para o usuario colar no SQL Editor do Supabase.

4. **Sincronizar o codigo com a VM.** A VM de producao (`163.176.107.172`, usuario `ubuntu`) **nao e um checkout git** — foi copiada por rsync. Use uma chave SSH autorizada nela (o caminho varia por maquina — pergunte ou procure em `~/.ssh/` ou numa pasta de chaves do projeto se nao souber):
   ```bash
   rsync -avz --delete \
     --exclude ".git" --exclude "node_modules" --exclude ".tmp_preview" \
     --exclude "coverage" --exclude "logs" --exclude ".env" --exclude ".env.*" \
     --exclude "storage/*" --exclude "credentials" \
     -e "ssh -i /caminho/da/sua/chave.key" \
     ./ ubuntu@163.176.107.172:~/estimulo-project/
   ```

5. **Rebuild e recriar os containers da aplicacao** (api + todos os workers — o build e rapido por causa do cache de camadas do Docker, entao normalmente vale rebuildar todos em vez de tentar adivinhar quais foram afetados):
   ```bash
   ssh -i /caminho/da/sua/chave.key ubuntu@163.176.107.172 \
     "cd ~/estimulo-project/infra && docker compose --env-file ../.env build api campaign-trigger-worker dispatch-worker dispatch-review-timeout-worker dispatch-failure-retry-worker mensagens-dispatch-worker group-sync-worker drive-video-index-worker && docker compose --env-file ../.env up -d --no-deps api campaign-trigger-worker dispatch-worker dispatch-review-timeout-worker dispatch-failure-retry-worker mensagens-dispatch-worker group-sync-worker drive-video-index-worker"
   ```
   **Nunca** rebuilde/recrie `redis`, `caddy`, `evolution-api` ou `evolution-postgres` num deploy de codigo normal — eles nao mudam com commits da aplicacao, e `evolution-api`/`evolution-postgres` guardam sessao ativa do WhatsApp (derrubar sem necessidade arrisca desconectar o numero).
   Sempre use `--env-file ../.env` — sem isso o compose sobe os containers de Evolution/Redis com credenciais vazias.

6. **Confirmar saude:**
   ```bash
   ssh -i /caminho/da/sua/chave.key ubuntu@163.176.107.172 \
     "cd ~/estimulo-project/infra && docker compose ps --format 'table {{.Name}}\t{{.Status}}'"
   ```
   Todos os containers da aplicacao devem estar `Up`/`healthy` e sem erro no `docker compose logs --tail=20 <servico>`. Se algo nao subir saudavel, investigue os logs antes de reportar sucesso.

7. **Reportar ao usuario**: o que foi deployado (resumo dos commits novos), se ha migration pendente (com o SQL pronto pra colar), e a confirmacao de que os containers estao saudaveis. Nao afirme que o deploy funcionou sem ter checado o passo 6.

## Git — identidade e commits

Este projeto tem uma politica explicita de **nao deixar Claude como autor/co-autor/colaborador** em nenhum commit. Ao commitar em nome do usuario:
- Nao adicione o trailer `Co-Authored-By: Claude ...` nem qualquer mencao a Claude/Anthropic na mensagem de commit.
- O `git config user.name`/`user.email` da maquina ja deve estar configurado com a identidade do usuario humano — confirme com `git log -1 --format='%an <%ae>'` antes de commitar, e nao mude para uma identidade sua.
