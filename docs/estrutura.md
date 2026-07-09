# Estrutura de Pastas

Resumo do papel de cada pasta principal do projeto.

```text
src/
  agents/        Agentes LangGraph, prompts e fluxos de decisao com IA.
  api/           Rotas HTTP, controllers e middlewares do backend.
  config/        Configuracoes da aplicacao e leitura de variaveis de ambiente.
  database/      Conexao com banco, migrations, seeds e configuracao do ORM.
  domain/        Regras centrais do negocio: organizacoes, grupos, campanhas e trilhas.
  queues/        Filas, scheduler interno, jobs repetiveis, retry e jitter.
  repositories/  Acesso aos dados e isolamento das consultas ao banco.
  services/      Integracoes externas e servicos de apoio, como Evolution, midia e alertas.
  shared/        Utilitarios, erros, logger e codigo comum entre modulos.
  workers/       Processos que consomem filas e executam tarefas em segundo plano.

docs/            Documentacao tecnica e decisoes de arquitetura.
infra/           Arquivos de infraestrutura, Docker, Redis, Evolution e deploy.
storage/         Arquivos gerados ou usados em runtime, como midias e temporarios.
tests/           Testes automatizados.
logs/            Logs locais da aplicacao, nao versionados.
scripts/         Scripts auxiliares de desenvolvimento, manutencao ou deploy.
```

As subpastas devem ser criadas apenas quando houver codigo suficiente para justificar a separacao.
