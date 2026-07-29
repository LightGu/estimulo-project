# Estrutura de Pastas

Resumo do papel de cada pasta principal do projeto.

```text
src/
  api/           App Express, rotas e controllers do backend.
  config/        Leitura de variaveis de ambiente: Supabase, Redis, Evolution, rede.
  database/      Cliente Supabase compartilhado pelos repositories.
  domain/        Regras centrais do negocio (perfis de trilha).
  queues/        Filas BullMQ, processadores, schedulers, retry e jitter.
  repositories/  Acesso aos dados e isolamento das consultas ao banco.
  services/      Regras de aplicacao e integracoes externas (Evolution, Google Drive, IA).
    ai/          Adapter do Gemini, prompts e settings dos agentes de IA.

public/app/      Frontend estatico servido pela propria API em /app.
docs/            Documentacao tecnica e decisoes de arquitetura.
infra/           Docker Compose do ambiente local (Redis + Evolution API).
supabase/        Migrations SQL aplicadas via Supabase CLI.
scripts/         Entrypoints dos workers, da API e utilitarios de manutencao.
storage/         Arquivos de runtime, como o estado do indexador do Drive.
tests/           Testes automatizados (runner nativo do Node, sem framework).
credentials/     Chaves de conta de servico do Google. Nao versionado.
logs/            Logs locais da aplicacao. Nao versionado.
```

As subpastas devem ser criadas apenas quando houver codigo suficiente para justificar a separacao.
Nao versione pasta vazia com `.gitkeep`: crie a pasta junto com o primeiro arquivo real.
A unica excecao e `storage/.gitkeep`, que existe porque o `.gitignore` ignora o
conteudo de `storage/` mas precisa manter a pasta no repositorio.

## Camadas

O fluxo esperado de dependencia e sempre em uma direcao:

```text
api/controllers  ->  services  ->  repositories  ->  database/client
queues (workers) ->  services  ->  repositories  ->  database/client
```

- Controller nao fala com repository nem com banco direto.
- Repository nao chama service.
- Toda entrega no WhatsApp passa por `src/services/evolution.js`.
- Todo acesso ao Google Drive passa por `src/services/google-drive.js`.
