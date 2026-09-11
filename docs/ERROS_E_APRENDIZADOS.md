# Erros e Aprendizados

Registro dos incidentes de producao ja enfrentados neste projeto: o que
aconteceu, a causa raiz, como foi corrigido e o que ficou como trava contra
repeticao (teste, migration, mudanca de processo). Ordem cronologica.

O objetivo nao e constranger ninguem por um bug — e parar de pagar o mesmo
preco duas vezes. Varios destes ja tem regressao coberta por teste; onde tem,
o teste esta citado, e ele *e* a garantia de que o erro nao volta, nao esta
doc.

Ao adicionar uma entrada nova: data, o que aconteceu (sintoma observado, nao a
causa), causa raiz, correcao, e a licao em uma frase. Se corrigiu um incidente
sem cobrir com teste ou trava estrutural, diga isso explicitamente — um
incidente sem trava e so questao de tempo para repetir.

---

## Timeout de migration nao aplicado bloqueando todas as seguintes

**Quando:** descoberto e corrigido em 02/09/2026.

**O que aconteceu:** `supabase db push` tentava reaplicar
`202608280001_add_app_users_display_name.sql` a cada execucao e morria com
erro de chave duplicada, travando **todas** as migrations posteriores
(`202608310001`, `202609010001`, `202609020001` ficaram presas atras disso).

**Causa raiz:** dois arquivos de migration nasceram com o mesmo timestamp
(`202608280001`) — um chamado `fix_organizations_schema_drift` e outro
`add_app_users_display_name`. `supabase_migrations.schema_migrations` usa a
versao (o timestamp) como chave; so um dos dois cabia la. A versao ficou
registrada com o nome do primeiro, e o segundo arquivo era eternamente
"pendente" aos olhos do Supabase, mesmo com o `ALTER TABLE` dele ja aplicado
manualmente em producao havia dias.

**Correcao:** o arquivo duplicado foi renomeado para
`202608280006_add_app_users_display_name.sql` (proximo timestamp livre do
mesmo dia — a ordem de aplicacao nao muda). O conteudo foi mantido intacto,
porque ja estava aplicado; so o nome do arquivo mudou.

**Trava:** nenhuma automatica — e um cuidado de processo. Antes de criar uma
migration nova, confira se ja nao existe um arquivo com o mesmo prefixo de
data em `supabase/migrations/`.

**Licao:** timestamp de migration precisa ser unico no arquivo, nao so
"correto pela data". Duas migrations no mesmo dia precisam de sufixos
diferentes, sempre.

---

## Campanha cancelada continuava bloqueando sua janela de horario

**Quando:** investigado e corrigido em 02/09/2026.

**O que aconteceu:** um disparo pontual novo, nos mesmos grupos e no mesmo
horario de uma campanha ja cancelada pelo usuario, falhava com 409 "Ja existe
campanha ativa no mesmo periodo" — apontando para uma campanha que o proprio
usuario tinha cancelado. O bloqueio nao vencia nunca para aquele horario.

**Causa raiz:** `cancelCampaign` (`src/services/campaigns.service.js`)
gravava so `{ status: "cancelado" }` e deixava `ativo` como `true`. A checagem
de conflito de janela (`campaigns.repository.listActiveOverlappingWindow`)
filtra por `ativo = true` e **nao olha o status** — e a comparacao de janela
(`start < fim_novo AND fim > inicio_novo`) nunca "vence" sozinha com o tempo.

**Correcao:** o service passou a gravar `ativo = false` junto do
cancelamento; migration `202609020001_backfill_canceled_campaigns_ativo.sql`
corrigiu as linhas ja canceladas antes do fix (5 em producao).

**Trava:** `tests/campaign-window-conflict.test.js` cobre o caminho.

**Licao:** um filtro de "esta ativo" e um campo de "status" que descrevem a
mesma coisa por dois caminhos diferentes **vao divergir** se so um dos dois
caminhos for atualizado numa mudanca de estado. Ao adicionar um novo status
terminal, audite todo filtro que usa o campo booleano equivalente.

---

## Cancelamento sem auditoria: nao dava pra saber quem, nem quando

**Quando:** apareceu na investigacao do incidente de 02/09/2026, corrigido em
03/09/2026 — 34 grupos de uma campanha apareceram cancelados sem o banco saber
dizer de onde partiu nem por quem.

**O que aconteceu:** um envio cancelado gravava so `status = 'cancelado'`.
Nao havia `updated_at` na tabela `logs`, entao a unica data disponivel era
`criado_em` (a do agendamento, nao a do cancelamento) — a tela chegou a
mostrar 02:34 (agendamento) para um cancelamento que aconteceu as 12:16.
`cancelPendingByCampaign` (cancelamento pedido pelo usuario) tambem nao
escrevia `mensagem_erro`, enquanto a trava de atraso automatica escrevia — mas
as duas origens ficavam indistinguiveis quando a mensagem vinha nula por
qualquer outro motivo.

**Causa raiz:** o schema nunca previu "quem" e "quando" para uma mudanca de
estado que pode vir de multiplas origens (usuario, trava de atraso, cascata de
campanha cancelada, sistema).

**Correcao:** tres migrations em sequencia —
`202609020002_add_logs_cancelamento_auditoria.sql` (`cancelado_em`,
`cancelado_origem` com vocabulario fechado),
`202609030001_add_cancelado_por.sql` (`cancelado_por`, FK para `app_users`,
nula em cancelamento automatico) e
`202609030002_add_logs_atualizado_em.sql` (`atualizado_em`, mantido por
trigger de banco, nao pela aplicacao — porque envios sao atualizados por
muitos caminhos diferentes e bastaria um esquecer para o buraco voltar).

**Trava:** `tests/cancel-audit.test.js` (`npm run test:cancel-audit`).

**Licao:** qualquer coluna de status/estado que pode ser alterada por mais de
uma origem (usuario vs. sistema vs. cascata) precisa nascer com "quem" e
"quando" desde o dia um — adicionar depois so cobre o que vier dali pra
frente, o passado fica com o buraco para sempre (por design: nao inventar
dado que nunca foi gravado).

---

## Envio saiu, gravacao falhou: "enviados: N" mentindo pro operador

**Quando:** 04/09/2026, 21:13 e 21:45 UTC. Corrigido em 07/09/2026.

**O que aconteceu:** dois disparos pontuais reais sairam para grupos de
WhatsApp e **nunca apareceram no relatorio** — zero linhas em `logs`. A tela
respondeu HTTP 200 "enviados: N" nos dois casos. Nao ha como recuperar quais
grupos receberam — o `catch` do erro so registrava a mensagem, nao os
destinatarios; a unica fonte seria o proprio historico do WhatsApp.

**Causa raiz dupla:**
1. A tela do Disparador Pontual oferece a classificacao "Capacitacao", o
   service aceitava `capacitacao`, mas a constraint
   `campaigns_classificacao_check` so permitia
   `('evento','credito','pesquisa','aviso','outro')`.
2. `dispatchAdHoc` enviava a mensagem **antes** de gravar a campanha ancora em
   `logs`. Quando o INSERT da ancora era recusado pela constraint, o envio ja
   tinha saido — o try/catch em volta so logava o evento
   `mensagens.persist_ad_hoc_campaign_failed` e a funcao seguia como se nada
   tivesse acontecido.

**Correcao:**
`202609070001_fix_campaigns_classificacao_capacitacao.sql` adiciona
`capacitacao` a constraint. Mais importante: a **ordem foi invertida** — o log
agora e criado como `pendente` **antes** do envio e fechado com o desfecho
depois; se nao da para registrar, a funcao rejeita e nao envia nada. Falhar
sem enviar e recuperavel; enviar sem registrar nao e.

**Trava:** `tests/mensagens-classificacao-schema-contract.test.js` trava
banco + service + tela juntos contra esse valor especifico.
`tests/dispatch-always-logged.test.js` fixa a regra geral como regressao
(`testFalhaAoGravarAncoraNaoEnviaNada`).

**Licao:** *nunca* envie antes de garantir que da pra registrar. Numa acao
irreversivel (mandar uma mensagem de verdade), a ordem "registra, depois
executa, depois atualiza o registro com o resultado" e a unica que nao perde
informacao quando o meio do caminho falha. E: toda vez que a tela ganha uma
opcao nova (um enum, uma classificacao, um tipo), audite se o banco tem uma
constraint que precisa acompanhar.

---

## Coluna nova quebrando 100% dos envios durante a janela de deploy

**Quando:** identificado como padrao recorrente e resolvido em 07/09/2026
(mesmo formato do incidente de schema drift em `organizations`, corrigido em
27/08/2026).

**O que aconteceu (risco, nao incidente confirmado neste caso especifico):**
o projeto nao tem CLI do Supabase linkado — migrations sao coladas
manualmente no SQL Editor, **depois** do codigo novo ja estar rodando (ver
`docs/DEPLOY_ORACLE.md`). Entre "container novo no ar" e "SQL colado", se o
codigo novo grava numa coluna que ainda nao existe, o PostgREST recusa o
INSERT **inteiro** com `PGRST204`/`42703` — nenhum log seria criado, ou seja,
nenhum envio aconteceria, ate o SQL ser colado.

**Correcao preventiva:** `createLog`
(`src/repositories/dispatch-logs.repository.js`) degrada para colunas
"opcionais" que ainda nao existem no banco — grava a linha sem a coluna
faltante e emite `dispatch_logs.optional_column_missing` uma vez por
processo, em vez de derrubar o INSERT inteiro. So e seguro fazer isso para
colunas que nunca participam de decisao de envio (hoje, so `dispatch_ref`).

**Trava:** `tests/dispatch-logs-optional-column.test.js`.

**Licao:** numa arquitetura sem migration automatica atrelada ao deploy, toda
coluna nova que o codigo passa a **gravar** (nao so ler) e um risco de
interrupcao total durante a janela entre deploy de codigo e aplicacao do SQL.
Ou a ordem e sempre "SQL antes do rebuild" (ver `README.md`, secao Deploy,
passo 3) e nunca falha, ou o codigo precisa tolerar a ausencia da coluna nessa
janela. As duas coisas juntas sao a rede de seguranca real.

---

## Reenvio de dias atras ao reiniciar a infra (spam)

**Quando:** identificado e corrigido em torno de 21-22/08/2026 (`dispatch-staleness.js`
e o teste de regressao entraram nesses dois dias — primeira entrada historica
deste documento).

**O que aconteceu:** subir a infra Docker depois de um periodo parado
reenviava para grupos de WhatsApp campanhas e mensagens agendadas **dias
antes**.

**Causa raiz:** o Redis sobe com `--appendonly yes` e volume persistente —
todo job de envio que nao terminou continua gravado entre um
`docker compose down` e o `up` seguinte. Ao voltar, a BullMQ promove de uma
vez todos os jobs `delayed` vencidos (rajada, delay 0), reentrega os que
ficaram `active` no shutdown e re-registra os agendamentos recorrentes — todos
rodando no instante do boot, sem nocao de quanto tempo passou.

**Correcao:** camada de travas por atraso (fail-closed) em
`src/services/dispatch-staleness.js` e nos processors das filas: teto por
job (`MAX_DISPATCH_DELAY_MS`, `MAX_VIDEO_DISPATCH_DELAY_MS`), teto absoluto
mesmo dentro de janela escolhida (`MAX_ABSOLUTE_DISPATCH_DELAY_MS`), e teto de
idade para auto-confirmacao (`MAX_AUTO_CONFIRM_AGE_MS`). Detalhe completo e
tabela de travas: `docs/filas.md`, secao "Reenvio no boot".

**Trava:** `tests/dispatch-boot-replay.test.js` (`npm run test:boot-replay`) —
cobre pelo lado que importa para quem recebe: o sender **nunca** pode ser
chamado para um job vencido, entao quase todo assert do arquivo e negativo
(`sent.length === 0`).

**Licao:** uma fila persistente (Redis com `appendonly`) e otima para
sobreviver a um restart sem perder trabalho — e perigosa se nada souber
reconhecer "isto era pra ter rodado ha muito tempo, nao rodar agora do jeito
que foi pedido". Toda fila com jobs agendados no futuro precisa de uma
resposta explicita para "e se este job so for processado bem depois do
previsto?" antes de ir pra producao.

---

## Reenvio do Baileys (WhatsApp) que nao vem da nossa fila

**Quando:** observado em 21/08/2026.

**O que aconteceu:** mensagens saindo para grupos sem nada correspondente nas
filas da aplicacao (`logs` com `falhou=0`/`pendente=0`, Redis vazio).

**Causa raiz:** nao e um bug da aplicacao — e `sendMessagesAgain`, o retry
automatico do proprio protocolo do WhatsApp (Baileys): quando um aparelho do
destinatario nao consegue descriptografar uma mensagem, ele pede reenvio ao
WhatsApp, que fica acumulado no servidor deles e e entregue quando a
instancia reconecta.

**O que foi tentado e piorou:** apagar a tabela `Message` do Postgres da
Evolution, supondo que sem o conteudo original o reenvio seria pulado. Nao
foi — o Baileys enviou uma **mensagem vazia** no lugar (3 mensagens vazias
chegaram a um grupo de cliente nesse teste). As duas pontas sao ruins: com
conteudo, reenvia mensagem antiga; sem conteudo, manda vazio.

**Correcao real:** invalidar a sessao dona daqueles ids de mensagem (logout
da instancia + novo pareamento por QR Code). Os pedidos de reenvio pendentes
passam a referenciar um dispositivo que nao existe mais e sao descartados
pelo WhatsApp.

**Trava:** nao aplicavel — e comportamento externo (Baileys/WhatsApp), nao
codigo deste projeto. Documentado em `docs/filas.md` para nao ser reinvestigado
do zero.

**Licao:** nem todo sintoma de "mensagem saiu sem estar na nossa fila" e bug
nosso. Confira o log da Evolution (`grep "sending message again"`) antes de
cacar no proprio codigo. E: NAO apague dados pra "testar uma hipotese" num
sistema que fala com gente de verdade do outro lado — o efeito colateral
(mensagem vazia) foi pior que o problema original.

---

## Ver tambem

- `docs/MIGRATIONS_APLICADAS_202609.md` — registro detalhado, com evidencia e
  verificacao em tres camadas, da leva de migrations de 07/09/2026 (varias das
  entradas acima resumem incidentes descritos la com mais profundidade).
- `docs/filas.md`, secoes "Reenvio no boot" e "Quem cancelou um envio, e
  quando" — o comportamento correto de hoje para os dois temas mais
  recorrentes aqui.
- `CLAUDE.md` (local, fora do repositorio — nao versionado de proposito) —
  playbook operacional de deploy.
