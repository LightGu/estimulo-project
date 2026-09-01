/*
  Traducao de erro tecnico para linguagem de operador.

  O painel ja tinha a caixa central de erro (estimuloErroInesperado em nav.js),
  mas o texto dentro dela vinha cru do backend: os services do src/services
  lancam mensagens em ingles tecnico ("Group has no trilha selected", "No
  approved video found for trail"), os controllers repassam essa string no
  { error } do 4xx, e a tela mostrava ela literalmente. Quando nem isso existia
  sobrava "Falha na requisicao (400)" ou o "Failed to fetch" do proprio browser.
  Nenhum dos tres diz ao operador o que fazer.

  Aqui cada erro conhecido vira { titulo, texto, acao }:
    - titulo: o que aconteceu, em uma linha ("Falta escolher a trilha do grupo")
    - texto:  por que aconteceu, sem jargao
    - acao:   o proximo passo concreto, quando existe um

  A mensagem original nunca e' descartada: nav.js continua colocando ela no
  <details> "Detalhes tecnicos", que e' o que a equipe pede num chamado.

  Casamento por chave exata primeiro (dicionario), depois por padrao regex, e
  por ultimo o fallback por status HTTP. Chave exata e' de proposito: se um
  service mudar o texto do throw, o erro cai no fallback generico - que ainda e'
  legivel - em vez de casar com a traducao errada.
*/
(function () {
  "use strict";

  // Falta de dado no formulario. O operador consegue resolver sozinho, entao o
  // texto sempre aponta o campo.
  var OBRIGATORIOS = {
    "Nome is required": "nome",
    "Group name is required": "nome do grupo",
    "Organization name is required": "nome da organizacao",
    "Organization id is required": "organizacao",
    "Group id is required": "grupo",
    "Campaign id is required": "disparo",
    "Trilha id is required": "trilha",
    "Trilha is required": "trilha",
    "Trilha destino id is required": "trilha de destino",
    "Destination trilha id is required": "trilha de destino",
    "Video id is required": "video",
    "Profile id is required": "perfil",
    "Profile is required": "perfil",
    "Caption id is required": "legenda",
    "Caption text is required": "texto da legenda",
    "Campaign video caption id is required": "legenda do video",
    "Desvio id is required": "desvio",
    "Dispatch log id is required": "registro de disparo",
    "Notification id is required": "notificacao",
    "Macrotema is required": "macrotema",
    "Segmento is required": "segmento",
    "Status is required": "status",
    "Start date is required": "data de inicio",
    "End date is required": "data de fim",
    "Drive file id is required": "arquivo do Drive",
    "Nome do arquivo is required": "nome do arquivo",
    "instance_name is required": "nome da instancia",
    "whatsapp_instance_id is required": "numero de WhatsApp",
    "Evolution group id is required": "grupo do WhatsApp",
    "timezone is required": "fuso horario",
    "folder_url_or_id is required": "link ou ID da pasta",
    "Planned dispatch time is required": "horario planejado do disparo",
    "Campaign trail is required": "trilha do disparo",
    "orderedTrilhaIds is required": "ordem das trilhas",
    "orderedVideoIds is required": "ordem dos videos",
    "Id do usuario e obrigatorio.": "usuario",
    "Pasta raiz do Drive e obrigatoria": "pasta raiz do Drive",
  };

  // Registro que o backend nao achou. Quase sempre e' tela desatualizada ou
  // item apagado por outra pessoa - por isso a acao e' recarregar.
  var NAO_ENCONTRADOS = {
    "Group not found": "grupo",
    "Campaign not found": "disparo",
    "Trilha not found": "trilha",
    "Trilha destino not found": "trilha de destino",
    "After trilha not found": "trilha seguinte",
    "Video not found": "video",
    "Profile not found": "perfil",
    "Organization not found": "organizacao",
    "Caption not found": "legenda",
    "Campaign video caption not found": "legenda do video",
    "Desvio not found": "desvio",
    "Instance not found": "numero de WhatsApp",
    "Usuario nao encontrado.": "usuario",
    "Registro video_catalog nao encontrado": "video no catalogo",
  };

  // Item duplicado. O nome do que ja existe entra no titulo.
  var JA_EXISTEM = {
    "Group already exists": "Esse grupo ja esta cadastrado",
    "Organization already exists": "Essa organizacao ja esta cadastrada",
    "Trilha already exists": "Essa trilha ja existe",
    "Profile already exists": "Esse perfil ja existe",
    "Instance already exists": "Esse numero de WhatsApp ja esta cadastrado",
    "Drive file id already exists": "Esse video do Drive ja esta no catalogo",
    "Video already in trilha": "Esse video ja esta nessa trilha",
    "Trilha already in this profile's sequence": "Essa trilha ja esta na ordem desse perfil",
    "Ja existe um usuario com esse nome.": "Ja existe um usuario com esse nome",
    "Delivery already registered": "Essa entrega ja foi registrada",
  };

  // Tudo que nao cabe nos padroes acima e precisa de explicacao propria.
  var DICIONARIO = {
    // ----- Sessao e acesso -----
    "Sessao invalida.": {
      titulo: "Sua sessao expirou",
      texto: "Por seguranca, o acesso expira depois de um tempo sem uso.",
      acao: "Entre novamente para continuar.",
    },
    "Usuario ou senha incorretos": {
      titulo: "Usuario ou senha incorretos",
      texto: "Os dados informados nao conferem.",
      acao: "Confira o usuario e a senha e tente de novo.",
    },
    "Voce nao pode apagar o proprio login.": {
      titulo: "Voce nao pode apagar o proprio login",
      texto: "Isso tiraria seu acesso ao painel na hora.",
      acao: "Pedra a outro administrador para remover esse usuario.",
    },
    "Nao e possivel apagar o unico administrador do painel.": {
      titulo: "Este e o unico administrador do painel",
      texto: "Se ele for removido, ninguem podera gerenciar usuarios e configuracoes.",
      acao: "Crie outro administrador antes de remover este.",
    },
    "Informe um nome de usuario.": {
      titulo: "Falta o nome de usuario",
      texto: "O nome de usuario e o que a pessoa digita para entrar no painel.",
      acao: "Preencha o nome de usuario.",
    },
    "Informe um nome de exibicao.": {
      titulo: "Falta o nome de exibicao",
      texto: "E o nome que aparece no topo do painel para essa pessoa.",
      acao: "Preencha o nome de exibicao.",
    },

    // ----- Numeros de WhatsApp -----
    "No active WhatsApp instances registered": {
      titulo: "Nenhum numero de WhatsApp cadastrado",
      texto: "O disparo precisa de pelo menos um numero conectado para enviar.",
      acao: "Cadastre e conecte um numero em Configuracoes > Numeros de WhatsApp.",
    },
    "All WhatsApp instances are paused": {
      titulo: "Todos os numeros de WhatsApp estao pausados",
      texto: "Numero pausado nao entra em disparo, entao nao ha por onde enviar.",
      acao: "Reative pelo menos um numero em Configuracoes > Numeros de WhatsApp.",
    },
    "Groups missing coverage on all active WhatsApp instances": {
      titulo: "Alguns grupos nao estao em nenhum numero ativo",
      texto:
        "Cada grupo precisa estar dentro de um numero de WhatsApp que participe do disparo. " +
        "Ha grupos selecionados que nenhum numero ativo alcanca.",
      acao: "Sincronize os grupos ou reative o numero que atende esses grupos.",
    },
    "Evolution API did not return a QR code": {
      titulo: "Nao foi possivel gerar o QR Code",
      texto: "O servico de WhatsApp nao respondeu com o codigo de conexao.",
      acao: "Tente gerar o QR Code novamente em alguns instantes.",
    },
    "paused must be a boolean": {
      titulo: "Nao foi possivel mudar a pausa do numero",
      texto: "O painel enviou um valor inesperado para essa acao.",
      acao: "Recarregue a pagina e tente de novo.",
    },

    // ----- Grupos -----
    "Group has no trilha selected": {
      titulo: "Falta escolher a trilha do grupo",
      texto: "Sem trilha definida o painel nao sabe qual video mandar para esse grupo.",
      acao: "Abra o grupo em Grupos e escolha a trilha dele.",
    },
    "Group must have envia_video=true": {
      titulo: "Esse grupo nao esta configurado para receber video",
      texto: "O envio de video esta desligado para ele.",
      acao: "Ative o envio de video nas configuracoes do grupo.",
    },
    "grupo com envia_video=false nao pode ser enfileirado para dispatch de video": {
      titulo: "Esse grupo nao esta configurado para receber video",
      texto: "O envio de video esta desligado para ele, entao ficou de fora do disparo.",
      acao: "Ative o envio de video nas configuracoes do grupo.",
    },
    "Video does not belong to the group's current trilha": {
      titulo: "Esse video nao faz parte da trilha atual do grupo",
      texto: "Um grupo so pode receber videos da trilha em que ele esta.",
      acao: "Troque a trilha do grupo ou escolha um video dessa trilha.",
    },
    "At least one group id is required": {
      titulo: "Nenhum grupo selecionado",
      texto: "E preciso escolher para quem o envio vai.",
      acao: "Marque pelo menos um grupo.",
    },
    "Selecione ao menos um grupo": {
      titulo: "Nenhum grupo selecionado",
      texto: "E preciso escolher para quem o envio vai.",
      acao: "Marque pelo menos um grupo.",
    },
    "groups deve conter ao menos um grupo": {
      titulo: "Nenhum grupo selecionado",
      texto: "E preciso escolher para quem o envio vai.",
      acao: "Marque pelo menos um grupo.",
    },
    "Maturidade must be between 1 and 4": {
      titulo: "Maturidade fora do intervalo",
      texto: "A maturidade do grupo vai de 1 a 4.",
      acao: "Escolha um valor entre 1 e 4.",
    },
    "At least one operational setting is required": {
      titulo: "Nada foi alterado",
      texto: "Nenhum campo do grupo foi modificado, entao nao ha o que salvar.",
      acao: "Altere algum campo antes de salvar.",
    },
    "At least one field is required": {
      titulo: "Nada foi alterado",
      texto: "Nenhum campo foi modificado, entao nao ha o que salvar.",
      acao: "Altere algum campo antes de salvar.",
    },

    // ----- Perfis e setores -----
    "Profile is in use and cannot be removed": {
      titulo: "Esse perfil esta em uso",
      texto: "Existem grupos ligados a ele, e remover deixaria esses grupos sem perfil.",
      acao: "Mova os grupos para outro perfil antes de remover este.",
    },
    "Profile was not created from a merge": {
      titulo: "Esse perfil nao veio de uma fusao",
      texto: "So da para desfazer a fusao de perfis que foram fundidos antes.",
      acao: "Nenhuma acao necessaria - esse perfil ja e' original.",
    },
    "Exactly two profileIds are required": {
      titulo: "Selecione exatamente dois perfis",
      texto: "A fusao junta dois perfis por vez.",
      acao: "Marque dois perfis e tente de novo.",
    },
    "At least one setor is required": {
      titulo: "Nenhum setor selecionado",
      texto: "O desvio precisa valer para pelo menos um setor.",
      acao: "Marque pelo menos um setor.",
    },
    "Setor already has a desvio at this point in the sequence": {
      titulo: "Esse setor ja tem um desvio nesse ponto",
      texto: "Cada setor pode ter apenas um desvio por posicao da sequencia.",
      acao: "Escolha outro ponto da sequencia ou edite o desvio que ja existe.",
    },

    // ----- Trilhas e videos -----
    "Trilha is not part of this profile's sequence": {
      titulo: "Essa trilha nao esta na ordem desse perfil",
      texto: "A tela pode estar desatualizada em relacao a sequencia salva.",
      acao: "Recarregue a pagina e tente novamente.",
    },
    "orderedTrilhaIds must include every trilha currently in this profile's sequence": {
      titulo: "A ordem enviada nao cobre todas as trilhas",
      texto: "Alguem pode ter mudado a sequencia desse perfil enquanto voce reordenava.",
      acao: "Recarregue a pagina e refaca a ordenacao.",
    },
    "orderedVideoIds must match exactly the trilha's current videos": {
      titulo: "A ordem enviada nao cobre todos os videos",
      texto: "Alguem pode ter adicionado ou removido videos dessa trilha enquanto voce reordenava.",
      acao: "Recarregue a pagina e refaca a ordenacao.",
    },
    "orderedIds must be a non-empty array": {
      titulo: "Nenhuma ordem para salvar",
      texto: "A lista chegou vazia ao servidor.",
      acao: "Recarregue a pagina e refaca a ordenacao.",
    },
    "Video not in trilha": {
      titulo: "Esse video nao esta nessa trilha",
      texto: "A tela pode estar desatualizada em relacao ao que esta salvo.",
      acao: "Recarregue a pagina e tente novamente.",
    },
    "No approved video found for trail": {
      titulo: "Essa trilha nao tem video aprovado",
      texto: "So videos aprovados podem ser enviados, e nenhum video dessa trilha esta aprovado.",
      acao: "Aprove ao menos um video da trilha em Trilhas.",
    },
    "At least one video_id is required": {
      titulo: "Nenhum video selecionado",
      texto: "E preciso escolher ao menos um video.",
      acao: "Marque pelo menos um video.",
    },
    "Selected video has no drive_file_id or link_video": {
      titulo: "Esse video nao tem arquivo nem link",
      texto: "O painel nao encontrou de onde baixar esse video para enviar.",
      acao: "Reindexe a pasta do Drive ou informe o link do video.",
    },
    "Invalid status": {
      titulo: "Status invalido",
      texto: "O valor enviado nao e' um status reconhecido.",
      acao: "Recarregue a pagina e tente de novo.",
    },
    "Etapa must be a positive integer": {
      titulo: "Etapa invalida",
      texto: "A etapa precisa ser um numero inteiro maior que zero.",
      acao: "Informe um numero valido.",
    },
    "Envia video must be boolean": {
      titulo: "Nao foi possivel salvar o envio de video",
      texto: "O painel enviou um valor inesperado para esse campo.",
      acao: "Recarregue a pagina e tente de novo.",
    },

    // ----- Disparos e campanhas -----
    "Campaign already has delivered dispatches": {
      titulo: "Esse disparo ja teve envios entregues",
      texto: "Mudar ou apagar agora deixaria o historico inconsistente.",
      acao: "Crie um novo disparo em vez de alterar este.",
    },
    "Este disparo já teve envios realizados e não pode ser apagado, para preservar o histórico.": {
      titulo: "Esse disparo ja teve envios realizados",
      texto: "Ele nao pode ser apagado para preservar o historico de entregas.",
      acao: "Se precisar parar novos envios, cancele o disparo em vez de apagar.",
    },
    "Campanha ja concluida nao pode ser cancelada": {
      titulo: "Esse disparo ja terminou",
      texto: "Nao ha mais envios pendentes para cancelar.",
      acao: "Nenhuma acao necessaria.",
    },
    "Campanha foi cancelada e nao pode ser confirmada": {
      titulo: "Esse disparo foi cancelado",
      texto: "Um disparo cancelado nao pode ser confirmado depois.",
      acao: "Crie um novo disparo se quiser enviar.",
    },
    "Campanha nao esta pausada": {
      titulo: "Esse disparo nao esta pausado",
      texto: "So da para retomar um disparo que esteja pausado.",
      acao: "Recarregue a pagina para ver o status atual.",
    },
    "Nao ha envios pendentes para pausar nesta campanha": {
      titulo: "Nao ha envios pendentes para pausar",
      texto: "Todos os envios desse disparo ja sairam ou ja foram cancelados.",
      acao: "Recarregue a pagina para ver o status atual.",
    },
    "Existem legendas pendentes para esta campanha": {
      titulo: "Ainda ha legendas para revisar",
      texto: "O disparo so sai depois que todas as legendas dos videos forem aprovadas.",
      acao: "Revise as legendas pendentes deste disparo e confirme de novo.",
    },
    "Envio nao confirmado pelo provedor": {
      titulo: "O WhatsApp nao confirmou o envio",
      texto: "A mensagem foi enviada, mas nao veio confirmacao de entrega.",
      acao: "Confira no proprio WhatsApp se a mensagem chegou antes de reenviar.",
    },
    "Informe um texto ou um link de conteudo": {
      titulo: "Falta o conteudo da mensagem",
      texto: "A mensagem precisa de um texto ou de um link para ser enviada.",
      acao: "Escreva o texto ou informe o link.",
    },
    "window_start deve ser uma data/hora futura": {
      titulo: "A janela de envio esta no passado",
      texto: "Nao da para agendar um envio para um horario que ja passou.",
      acao: "Escolha uma data e um horario futuros.",
    },
    "window_start e window_end sao obrigatorios para agendar com intervalo": {
      titulo: "Falta a janela de envio",
      texto: "Para espalhar os envios o painel precisa saber o inicio e o fim da janela.",
      acao: "Preencha o horario de inicio e de fim.",
    },
    "window_start e window_end devem ser informados juntos": {
      titulo: "Falta parte da janela de envio",
      texto: "Inicio e fim da janela precisam ser preenchidos juntos.",
      acao: "Preencha os dois horarios.",
    },
    "jitter_delay_max_ms deve permitir horarios diferentes entre grupos": {
      titulo: "A janela de envio e' curta demais",
      texto:
        "Para nao enviar tudo no mesmo segundo, o painel espalha os grupos ao longo da janela - " +
        "e a janela atual nao da espaco para isso.",
      acao: "Aumente a janela de envio ou reduza a quantidade de grupos.",
    },

    // ----- Datas e relatorios -----
    "Start date cannot be after end date": {
      titulo: "As datas estao invertidas",
      texto: "A data de inicio ficou depois da data de fim.",
      acao: "Troque as datas de lugar.",
    },
    "Start date cannot be in the future": {
      titulo: "A data de inicio esta no futuro",
      texto: "O relatorio so cobre periodos que ja aconteceram.",
      acao: "Escolha uma data de inicio de hoje ou anterior.",
    },
    "End date cannot be in the future": {
      titulo: "A data de fim esta no futuro",
      texto: "O relatorio so cobre periodos que ja aconteceram.",
      acao: "Escolha uma data de fim de hoje ou anterior.",
    },
    "Execution date is invalid": {
      titulo: "Data invalida",
      texto: "A data informada nao foi reconhecida.",
      acao: "Escolha a data novamente no calendario.",
    },
    "execution_at deve ser uma data valida": {
      titulo: "Data invalida",
      texto: "A data informada nao foi reconhecida.",
      acao: "Escolha a data novamente no calendario.",
    },
    "scheduled_at deve ser uma data valida": {
      titulo: "Data invalida",
      texto: "A data informada nao foi reconhecida.",
      acao: "Escolha a data novamente no calendario.",
    },
    "window_start deve ser uma data valida": {
      titulo: "Horario invalido",
      texto: "O horario informado nao foi reconhecido.",
      acao: "Escolha o horario novamente.",
    },
    "timezone is invalid": {
      titulo: "Fuso horario invalido",
      texto: "O fuso informado nao e' reconhecido.",
      acao: "Escolha um fuso da lista.",
    },
    "hour must be an integer between 0 and 23": {
      titulo: "Hora invalida",
      texto: "A hora vai de 0 a 23.",
      acao: "Informe uma hora valida.",
    },
    "minute must be an integer between 0 and 59": {
      titulo: "Minuto invalido",
      texto: "Os minutos vao de 0 a 59.",
      acao: "Informe um minuto valido.",
    },
    "dispatch_periods entries must have valid inicio/fim times (HH:mm)": {
      titulo: "Horario da janela invalido",
      texto: "Os horarios precisam estar no formato hora:minuto.",
      acao: "Confira os horarios informados.",
    },
    "dispatch_periods entries must have inicio earlier than fim": {
      titulo: "Janela de envio invertida",
      texto: "O horario de inicio ficou depois do horario de fim.",
      acao: "Troque os horarios de lugar.",
    },
    "min_interval_min must be an integer greater than or equal to 1": {
      titulo: "Intervalo minimo invalido",
      texto: "O intervalo entre envios precisa ser de pelo menos 1 minuto.",
      acao: "Informe 1 minuto ou mais.",
    },
    "max_interval_min must be an integer greater than or equal to min_interval_min": {
      titulo: "Intervalos invertidos",
      texto: "O intervalo maximo ficou menor que o minimo.",
      acao: "Aumente o intervalo maximo.",
    },
    "whatsapp_rotation_group_count must be an integer greater than or equal to 1": {
      titulo: "Quantidade de grupos por numero invalida",
      texto: "A rotacao precisa de pelo menos 1 grupo por numero.",
      acao: "Informe 1 ou mais.",
    },
    "auto_send_after_timeout.minutes must be an integer greater than or equal to 1": {
      titulo: "Tempo de espera invalido",
      texto: "O envio automatico precisa esperar pelo menos 1 minuto.",
      acao: "Informe 1 minuto ou mais.",
    },

    // ----- Video, audio e legenda -----
    "Nao foi possivel gerar uma legenda valida para este video": {
      titulo: "Nao conseguimos gerar a legenda",
      texto: "A IA nao devolveu um texto aproveitavel para esse video.",
      acao: "Tente gerar de novo ou escreva a legenda manualmente.",
    },
    "Transcricao gerada esta vazia": {
      titulo: "Nao conseguimos transcrever o video",
      texto: "Nenhuma fala foi reconhecida no audio - o video pode estar sem som ou com som muito baixo.",
      acao: "Confira se o video tem audio audivel e tente de novo.",
    },
    "Extracao de audio gerou arquivo vazio (o video possui trilha de audio?)": {
      titulo: "Esse video parece nao ter audio",
      texto: "Sem audio nao e' possivel transcrever nem gerar legenda automatica.",
      acao: "Envie um video com audio ou escreva a legenda manualmente.",
    },
    "Nao foi possivel determinar a duracao do video para calcular o bitrate de compressao": {
      titulo: "Nao conseguimos ler esse video",
      texto: "O arquivo parece estar corrompido ou em um formato que nao reconhecemos.",
      acao: "Exporte o video em MP4 e envie de novo.",
    },
    "Recompressao gerou arquivo de video vazio": {
      titulo: "Nao conseguimos preparar esse video",
      texto: "A compressao terminou sem gerar arquivo - o video de origem pode estar corrompido.",
      acao: "Exporte o video em MP4 e envie de novo.",
    },
    "Resposta da Google Drive API nao contem bytes de video em formato suportado": {
      titulo: "Formato de video nao suportado",
      texto: "O arquivo baixado do Drive nao esta em um formato de video que conseguimos enviar.",
      acao: "Converta o arquivo para MP4 no Drive e reindexe a pasta.",
    },
    "Download do Google Drive nao retornou bytes de video validos": {
      titulo: "Nao conseguimos baixar esse video do Drive",
      texto: "O download veio incompleto ou em formato inesperado.",
      acao: "Confira se o arquivo abre no Drive e tente novamente.",
    },
    "Download do Google Drive retornou video vazio": {
      titulo: "O video do Drive esta vazio",
      texto: "O arquivo foi baixado com 0 bytes.",
      acao: "Confira o arquivo no Drive e reenvie se preciso.",
    },
    "Nao foi possivel extrair o ID da pasta a partir do link informado": {
      titulo: "Link da pasta nao reconhecido",
      texto: "O endereco informado nao parece ser de uma pasta do Google Drive.",
      acao: "Copie o link direto da pasta no Drive e cole aqui.",
    },
    "Drive root folder is not configured": {
      titulo: "A pasta do Drive nao esta configurada",
      texto: "O painel nao sabe de onde buscar os videos.",
      acao: "Informe a pasta raiz em Configuracoes > Google Drive.",
    },

    // ----- Erros do painel, nao do operador -----
    "Recurso nao encontrado nesta versao do painel": {
      titulo: "Essa acao nao existe mais nesta versao",
      texto: "A pagina aberta no seu navegador esta mais antiga que o painel no servidor.",
      acao: "Recarregue a pagina para carregar a versao atual.",
    },
    "Corpo da requisicao nao e um JSON valido": {
      titulo: "Ops... algo inesperado aconteceu",
      texto: "O painel montou o pedido de um jeito que o servidor nao entendeu.",
      acao: "Recarregue a pagina e tente novamente.",
    },
    "Internal server error": {
      titulo: "Ops... algo inesperado aconteceu",
      texto: "Tivemos um problema aqui do nosso lado ao processar sua acao - nao foi nada que voce fez.",
      acao: "Tente novamente em instantes. Se continuar, avise a equipe.",
    },
  };

  // Padroes para o que nao vale listar item por item: mensagens de campo
  // obrigatorio que o backend gera com nome de coluna, e os "is required"
  // genericos que sobrarem.
  var PADROES = [
    {
      teste: /^(.+) (e|é) obrigatorio(\.|)$/i,
      monta: function () {
        return {
          titulo: "Falta preencher um campo obrigatorio",
          texto: "Um dado necessario nao chegou preenchido.",
          acao: "Confira os campos do formulario e tente de novo.",
        };
      },
    },
    {
      teste: /is required$/i,
      monta: function () {
        return {
          titulo: "Falta preencher um campo obrigatorio",
          texto: "Um dado necessario nao chegou preenchido.",
          acao: "Confira os campos do formulario e tente de novo.",
        };
      },
    },
    {
      teste: /must be (a |an |)(boolean|string|number|integer|object|array)/i,
      monta: function () {
        return {
          titulo: "Um dado chegou em formato inesperado",
          texto: "O painel enviou um valor que o servidor nao aceitou.",
          acao: "Recarregue a pagina e tente novamente.",
        };
      },
    },
    {
      // Erros de contrato interno (AIProviderAdapter, repositorios, buildJobData):
      // bug nosso, nunca algo que o operador possa corrigir.
      teste: /^(AIProviderAdapter|buildJobData|videoCatalogRepository|drive\.files)/,
      monta: function () {
        return {
          titulo: "Ops... algo inesperado aconteceu",
          texto: "Uma parte interna do painel nao respondeu como esperado.",
          acao: "Avise a equipe com o detalhe tecnico abaixo.",
        };
      },
    },
    {
      teste: /excede o tamanho maximo/i,
      monta: function (mensagem) {
        return {
          titulo: "Arquivo grande demais",
          texto: mensagem,
          acao: "Reduza a duracao ou a qualidade do arquivo e envie de novo.",
        };
      },
    },
  ];

  // Erro de rede: a requisicao nem chegou ao servidor. O "Failed to fetch" do
  // browser nao diz nada ao operador, e a causa mais comum e' internet caindo
  // ou o painel reiniciando.
  var REDE = {
    titulo: "Nao conseguimos falar com o servidor",
    texto: "A conexao com o painel caiu no meio do caminho. Sua internet pode ter oscilado, ou o painel esta reiniciando.",
    acao: "Confira sua conexao e tente novamente.",
  };

  // Ultimo recurso, por faixa de status HTTP.
  function porStatus(status) {
    if (status === 401 || status === 403) {
      return {
        titulo: "Sua sessao expirou",
        texto: "Por seguranca, o acesso expira depois de um tempo sem uso.",
        acao: "Entre novamente para continuar.",
      };
    }
    if (status === 404) {
      return {
        titulo: "Nao encontramos o que voce pediu",
        texto: "O item pode ter sido apagado ou movido por outra pessoa.",
        acao: "Recarregue a pagina para ver a lista atualizada.",
      };
    }
    if (status === 409) {
      return {
        titulo: "Isso entra em conflito com algo que ja existe",
        texto: "Outro registro ja ocupa esse lugar.",
        acao: "Ajuste os dados e tente de novo.",
      };
    }
    if (status === 413) {
      return {
        titulo: "Arquivo grande demais",
        texto: "O arquivo enviado passa do tamanho que conseguimos processar.",
        acao: "Reduza a duracao ou a qualidade do arquivo e envie de novo.",
      };
    }
    if (status === 429) {
      return {
        titulo: "Muitas tentativas em pouco tempo",
        texto: "Bloqueamos por um instante para proteger sua conta.",
        acao: "Aguarde um minuto antes de tentar de novo.",
      };
    }
    if (status === 502 || status === 503 || status === 504) {
      return {
        titulo: "Um servico externo nao respondeu",
        texto: "O WhatsApp, o Google Drive ou a IA nao responderam em tempo. Nao foi nada que voce fez.",
        acao: "Tente novamente em alguns instantes.",
      };
    }
    if (typeof status === "number" && status >= 500) {
      return {
        titulo: "Ops... algo inesperado aconteceu",
        texto: "Tivemos um problema aqui do nosso lado - nao foi nada que voce fez.",
        acao: "Tente novamente em instantes. Se continuar, avise a equipe.",
      };
    }
    if (typeof status === "number" && status >= 400) {
      return {
        titulo: "Nao conseguimos concluir essa acao",
        texto: "Algum dado enviado nao foi aceito pelo servidor.",
        acao: "Confira os campos preenchidos e tente novamente.",
      };
    }
    return {
      titulo: "Ops... algo inesperado aconteceu",
      texto: "Nao conseguimos concluir sua acao agora.",
      acao: "Tente novamente em instantes. Se continuar, avise a equipe.",
    };
  }

  // Normaliza acento para casar "Sessão"/"Sessao" e afins vindos do backend.
  function semAcento(valor) {
    if (typeof valor.normalize !== "function") return valor;
    // ̀-ͯ = marcas de acento combinantes, escritas por escape para o
    // arquivo nao depender de como o editor salva esses caracteres.
    return valor.normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  function buscaExata(mensagem) {
    if (DICIONARIO[mensagem]) return DICIONARIO[mensagem];

    if (OBRIGATORIOS[mensagem]) {
      return {
        titulo: "Falta preencher: " + OBRIGATORIOS[mensagem],
        texto: "Esse dado e' necessario para concluir a acao.",
        acao: "Preencha o campo " + OBRIGATORIOS[mensagem] + " e tente de novo.",
      };
    }

    if (NAO_ENCONTRADOS[mensagem]) {
      return {
        titulo: "Nao encontramos esse " + NAO_ENCONTRADOS[mensagem],
        texto: "Ele pode ter sido apagado ou alterado por outra pessoa enquanto essa tela estava aberta.",
        acao: "Recarregue a pagina para ver os dados atualizados.",
      };
    }

    if (JA_EXISTEM[mensagem]) {
      return {
        titulo: JA_EXISTEM[mensagem],
        texto: "Nao e' possivel cadastrar duas vezes o mesmo item.",
        acao: "Use o registro que ja existe ou escolha outro nome.",
      };
    }

    return null;
  }

  /*
    Traduz um erro para { titulo, texto, acao, detalhe }.

    Aceita o Error com .status/.payload que os requestJson das telas montam,
    uma string solta (varias telas chamam estimuloTratarErro(error.message)),
    ou o TypeError do fetch quando a API esta fora do ar.
  */
  function traduzirErro(erro) {
    var mensagem = "";
    var status = null;
    var semRede = false;

    if (typeof erro === "string") {
      mensagem = erro;
    } else if (erro) {
      mensagem = erro.message || "";
      status = typeof erro.status === "number" ? erro.status : null;
      semRede = Boolean(erro.isApiUnreachable);
    }

    mensagem = String(mensagem).trim();

    // O TypeError do fetch chega sem status; a mensagem varia por browser
    // ("Failed to fetch" no Chrome, "NetworkError..." no Firefox, "Load
    // failed" no Safari).
    if (
      semRede ||
      (status === null && /failed to fetch|networkerror|load failed|network request failed/i.test(mensagem))
    ) {
      return {
        titulo: REDE.titulo,
        texto: REDE.texto,
        acao: REDE.acao,
        detalhe: mensagem || "Falha de rede",
      };
    }

    var achado = buscaExata(mensagem) || buscaExata(semAcento(mensagem));

    if (!achado) {
      for (var i = 0; i < PADROES.length; i += 1) {
        if (PADROES[i].teste.test(mensagem)) {
          achado = PADROES[i].monta(mensagem);
          break;
        }
      }
    }

    // Sem traducao: "Falha na requisicao (400)" e afins nao ajudam ninguem, mas
    // uma mensagem em portugues que o backend ja escreveu para o operador
    // ajuda - entao ela e' aproveitada como texto sob um titulo amigavel.
    if (!achado) {
      var base = porStatus(status);

      if (mensagem && !/^falha na requisicao/i.test(mensagem) && ehLegivel(mensagem)) {
        achado = { titulo: base.titulo, texto: mensagem, acao: base.acao };
      } else {
        achado = base;
      }
    }

    return {
      titulo: achado.titulo,
      texto: achado.texto,
      acao: achado.acao || "",
      detalhe: mensagem,
    };
  }

  /*
    Uma mensagem so e' mostrada crua se parecer escrita para uma pessoa: em
    portugues, sem nome de coluna nem identificador tecnico. Isso evita
    promover "auto_send_after_timeout must be an object" a texto principal.
  */
  function ehLegivel(mensagem) {
    if (/[_{}[\]<>]|::|=>/.test(mensagem)) return false;
    if (/\b(null|undefined|NaN|true|false)\b/.test(mensagem)) return false;
    if (/^[a-z][a-zA-Z0-9]*\./.test(mensagem)) return false;
    // Heuristica de idioma: mensagem escrita para o operador esta em portugues.
    if (!/[àáâãéêíóôõúçÀÁÂÃÉÊÍÓÔÕÚÇ]/.test(mensagem) && !/\b(nao|não|de|para|do|da|que|uma|ao|ja|já|com|em|esta|está|foi|ser|sao|são|pode|precisa|informe|selecione|existe|conta|voce|você)\b/i.test(mensagem)) {
      return false;
    }
    return true;
  }

  window.estimuloTraduzirErro = traduzirErro;

  /*
    Versao de uma linha, para os lugares que mostram o erro em texto corrido
    (as .status-line de configuracoes.html, os "Falha ao carregar..." dentro de
    um painel) em vez de abrir a caixa central. Junta titulo e acao, que e' o
    minimo para o operador entender e reagir sem sair da tela.

    Usage: setDriveStatus(window.estimuloErroEmLinha(error), "var(--danger)");
  */
  window.estimuloErroEmLinha = function estimuloErroEmLinha(erro) {
    var t = traduzirErro(erro);
    return t.acao ? t.titulo + ". " + t.acao : t.titulo;
  };

  /*
    Fetch + parse de JSON com o erro ja no formato que estimuloTratarErro espera.

    Existia como copia byte-a-byte em nove telas, e nenhuma delas tratava a
    rejeicao do proprio fetch: quando a API estava fora do ar o TypeError
    ("Failed to fetch") subia cru e o operador via essa frase em ingles, sem
    saber que o problema era conexao. Aqui a falha de rede vira um erro marcado
    com isApiUnreachable, que a traducao reconhece.
  */
  window.estimuloRequestJson = async function estimuloRequestJson(url, options) {
    var response;

    try {
      // Via window.fetch (e nao o global solto) para o teste poder injetar um
      // fetch falso; no navegador os dois sao o mesmo objeto.
      response = await window.fetch(url, options);
    } catch (falhaDeRede) {
      // TypeError do fetch: DNS, offline, servidor derrubado, CORS. A
      // requisicao nao chegou ao servidor, entao nao existe status HTTP.
      var erroRede = new Error(falhaDeRede && falhaDeRede.message ? falhaDeRede.message : "Failed to fetch");
      erroRede.isApiUnreachable = true;
      throw erroRede;
    }

    var payload = await response.json().catch(function () {
      return {};
    });

    if (!response.ok) {
      // O status vai junto porque estimuloTratarErro usa ele para escolher o
      // tom (5xx assume a culpa, 4xx aponta o campo) e para decidir se oferece
      // "Tentar novamente".
      var erro = new Error(payload.error || "Falha na requisicao (" + response.status + ")");
      erro.status = response.status;
      erro.payload = payload;
      throw erro;
    }

    return payload;
  };
})();
