const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use(cors({
  origin: ['https://ginger.ind.br', 'https://www.ginger.ind.br']
}));

// ══════════════════════════════════════════════════════════════
// ── WHATSAPP CLOUD API (META) — substitui a Z-API
// ══════════════════════════════════════════════════════════════
// Variáveis necessárias no Render:
//   WHATSAPP_TOKEN            → token permanente do system user "Ginger-Bot"
//   WHATSAPP_PHONE_NUMBER_ID  → 1175277422346620
//   WHATSAPP_VERIFY_TOKEN     → string livre, inventada por você, usada só na
//                               validação do webhook no painel da Meta
const GRAPH_VERSION = 'v21.0';
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
// ID da WhatsApp Business Account. Usado para consultar e criar o vinculo
// entre a conta e o app, que e o que faz a Meta entregar os webhooks.
const WABA_ID = '4379210335742127';

// Template aprovado para abordagem ativa (lead frio, fora da janela de 24h)
const TEMPLATE_ABORDAGEM = 'abordagem_lead_ginger';
const TEMPLATE_IDIOMA = 'pt_BR';

function urlMensagens() {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_ID}/messages`;
}

function headersWa() {
  return {
    'Authorization': `Bearer ${WA_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

// ── GOOGLE SHEETS CONFIG
const SPREADSHEET_ID = '1xDO8V0cx474-zceEGiDLufzkdm4JjeQnmRAHbR22xv8';
const SHEET_NAME = 'Página1';
// Aba de historico de conversas. Criada automaticamente se nao existir.
const SHEET_CONVERSAS = 'Conversas';
let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  try {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
    console.log('Google Sheets conectado com sucesso');
    return sheetsClient;
  } catch(e) {
    console.error('Erro ao conectar Google Sheets:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// ── UPSTASH REDIS CONFIG (persistência de conversas)
// ══════════════════════════════════════════════════════════════
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...args) {
  try {
    const response = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(args)
    });
    const data = await response.json();
    return data.result;
  } catch (e) {
    console.error('Redis erro:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// ── NORMALIZAÇÃO DE NÚMERO — CRÍTICO NA CLOUD API
// ══════════════════════════════════════════════════════════════
// A Meta devolve o wa_id de celulares brasileiros MUITAS VEZES sem o nono
// dígito (ex.: 551998354011 em vez de 5519998354011). Se a gente usar o número
// cru como chave, a conversa de saída e a de entrada viram duas conversas
// diferentes e o bot perde o histórico.
// Solução: uma chave canônica que SEMPRE remove o nono dígito.
// Usada só internamente (Redis e busca na planilha). Para ENVIAR, usamos
// o wa_id exato que a Meta mandou, ou o número completo da planilha.
function chaveNumero(numero) {
  if (!numero) return null;
  let n = String(numero).replace(/\D/g, '');
  if (n.startsWith('0')) n = n.substring(1);
  if (!n.startsWith('55')) n = '55' + n;
  const resto = n.slice(2);
  const ddd = resto.slice(0, 2);
  let assinante = resto.slice(2);
  if (assinante.length === 9 && assinante.startsWith('9')) {
    assinante = assinante.slice(1);
  }
  return '55' + ddd + assinante;
}

// ── Histórico de conversas (Redis)
async function getConversa(numero) {
  const data = await redis('GET', `conversa:${chaveNumero(numero)}`);
  if (!data) return null;
  try { return JSON.parse(data); } catch (e) { return null; }
}

async function saveConversa(numero, messages) {
  await redis('SET', `conversa:${chaveNumero(numero)}`, JSON.stringify(messages), 'EX', 86400);
}

async function isNumeroAbordado(numero) {
  const result = await redis('SISMEMBER', 'numeros_abordados', chaveNumero(numero));
  return result === 1;
}

async function marcarNumeroAbordado(numero) {
  await redis('SADD', 'numeros_abordados', chaveNumero(numero));
}

// ── Deduplicação de webhook. A Meta reenvia o mesmo evento se não receber 200
// rápido, e como o bot tem delay antes de responder, sem isso o lead recebe
// resposta duplicada.
async function jaProcessouMensagem(msgId) {
  if (!msgId) return false;
  const r = await redis('SET', `msg:${msgId}`, '1', 'NX', 'EX', 3600);
  return r !== 'OK';
}

function chaveDiaBrasil() {
  const agora = new Date();
  const brasil = new Date(agora.getTime() + (agora.getTimezoneOffset() * 60000) + (-3 * 3600000));
  const y = brasil.getFullYear();
  const m = String(brasil.getMonth() + 1).padStart(2, '0');
  const d = String(brasil.getDate()).padStart(2, '0');
  return `abordados_dia:${y}-${m}-${d}`;
}

async function getAbordadosHoje() {
  const v = await redis('GET', chaveDiaBrasil());
  return v ? parseInt(v) : 0;
}

async function incrementarAbordadosHoje() {
  const chave = chaveDiaBrasil();
  const novo = await redis('INCR', chave);
  await redis('EXPIRE', chave, 172800);
  return novo ? parseInt(novo) : 0;
}

async function getLeadPlanilha(numero) {
  const result = await redis('HGET', 'leads_planilha', chaveNumero(numero));
  return result ? parseInt(result) : null;
}

async function setLeadPlanilha(numero, rowIndex) {
  await redis('HSET', 'leads_planilha', chaveNumero(numero), rowIndex.toString());
}

// ══════════════════════════════════════════════════════════════
// ── TRAVAS DE SEGURANÇA
// ══════════════════════════════════════════════════════════════
let verificacaoRodando = false;

const MAX_POR_RODADA = 2;
// Na Cloud API oficial o limite inicial da Meta é de 250 clientes únicos por
// 24h e sobe conforme a qualidade do número. Mantido conservador no início.
// Pode subir depois que o número tiver histórico bom.
const TETO_DIARIO = 30;
const INTERVALO_MIN_MS = 90000;
const INTERVALO_MAX_MS = 180000;
const INTERVALO_VERIFICACAO_MS = 30 * 60 * 1000;

// Delay antes de responder. Na Z-API isso era proteção contra banimento.
// Na API oficial não há esse risco, então foi reduzido para não deixar o lead
// esperando. Ajuste aqui se quiser voltar ao ritmo antigo (20000 / 45000).
const RESPOSTA_DELAY_MIN_MS = 8000;
const RESPOSTA_DELAY_MAX_MS = 18000;

// ══════════════════════════════════════════════════════════════
// ── FILTRO DE CNAE — ESQUELETO (preencher quando a lista do jurídico chegar)
// ══════════════════════════════════════════════════════════════
const CNAE_QUALIFICA_DIRETO = [
  // '2063100', // ex.: fabricação de cosméticos
];

const CNAE_QUALIFICA_COM_VOLUME = {
  // '1113501': 8,   // ex.: cervejaria só qualifica se volume desejado (kg) >= 8
};

const CNAE_NAO_QUALIFICA = [
  // '5611201', // ex.: restaurante
];

function avaliarCnae(cnae) {
  const listasVazias =
    CNAE_QUALIFICA_DIRETO.length === 0 &&
    Object.keys(CNAE_QUALIFICA_COM_VOLUME).length === 0 &&
    CNAE_NAO_QUALIFICA.length === 0;
  if (listasVazias) return { status: 'sem_lista' };

  if (!cnae) return { status: 'sem_cnae' };
  const c = String(cnae).replace(/\D/g, '');

  if (CNAE_NAO_QUALIFICA.includes(c)) return { status: 'bloqueado' };
  if (CNAE_QUALIFICA_DIRETO.includes(c)) return { status: 'direto' };
  if (Object.prototype.hasOwnProperty.call(CNAE_QUALIFICA_COM_VOLUME, c)) {
    return { status: 'com_volume', volumeMinimo: CNAE_QUALIFICA_COM_VOLUME[c] };
  }
  return { status: 'sem_cnae' };
}

const SYSTEM_PROMPT = `Você é o agente de atendimento da Ginger Fragrance Design, uma casa de fragrâncias estratégica brasileira, B2B, focada em transformar fragrância em ativo de negócio para indústrias de HPPC, Saneantes, Home Care e Pet Care.

IDENTIDADE E MISSÃO
Propósito: Criar fragrâncias que fortalecem marcas e inspiram pessoas, gerando resultados reais aos clientes.
Missão: Ajudar clientes a transformar fragrância em ativo estratégico, gerando margem, diferenciação e fidelização.
A Ginger não é fornecedora de insumo. É parceira estratégica do negócio do cliente.

TESE CENTRAL
Fragrância não é commodity, é ativo estratégico que gera margem, diferenciação e fidelização do consumidor. Empresas que tratam fragrância como custo deixam dinheiro na mesa toda semana.

FRASE MEMORÁVEL DA GINGER
"A Ginger, como parceira estratégica do seu negócio, identifica as oportunidades e entrega a fragrância certa que acelera o seu resultado."

MÉTODO: GINGER FRAGRANCE DESIGN (GFD)
5 etapas: 1) Diagnóstico de portfólio, 2) Inteligência de mercado e consumidor, 3) Criação alinhada ao posicionamento, 4) Validação técnica (estabilidade, IFRA, compatibilidade), 5) Acompanhamento de resultado na gôndola.

ARQUITETURA DE CLIENTES
Ginger Core: pedidos R$5k a R$30k (transacional qualificado)
ICPs: pedidos acima de R$30k (consultivo, método Ginger)
Clientes ABM: potencial acima de R$200k (parceria estratégica profunda)

SEGMENTOS ATENDIDOS
Cosméticos, Higiene Pessoal (HPPC), Saneantes, Home Care, Pet Care, Perfumaria Fina e Aromatização de Ambiente.

As fragrâncias da Ginger se aplicam a qualquer produto que carregue fragrância, incluindo velas, difusores, aromatizadores, sprays de ambiente, produtos de limpeza, cosméticos, perfumes, produtos pet e qualquer outro segmento onde fragrância seja um atributo do produto. Nunca dizer que algo "não é nossa expertise", se o produto carrega fragrância, a Ginger pode desenvolver.

A Ginger também comercializa matérias-primas para fragrâncias. Se o contato perguntar, confirmar que sim e direcionar para o comercial.

AS QUATRO PERSONAS E SEUS ARGUMENTOS
1. CEO/Dono empresa grande: portfólio olfativo como ativo estratégico, credencial Sinter (R$1 bi em 5 anos, cerca de 5% market share sabonetes)
2. Empresário médio: ROI, margem, dinheiro na mesa
3. Profissional de Marketing: identidade olfativa, velocidade, co-criação
4. Gerente Técnico: estabilidade, zero devolução, documentação completa (IFRA, ficha técnica, histórico analítico)

DIFERENCIAIS COMPETITIVOS
Fundador foi cliente (CEO Sinter), entende a dor de dentro.
Método proprietário GFD.
Agilidade como modelo de operação.
Visão B2B2C, pensa no consumidor final do cliente.
Expertise em sourcing de matérias-primas.

VOCABULÁRIO OBRIGATÓRIO
SEMPRE: fragrância
NUNCA: essência, aroma, cheiro, cheirinho

⚠️ O QUE A GINGER FAZ E O QUE NÃO FAZ — REGRA CRÍTICA ⚠️
A Ginger desenvolve e fabrica FRAGRÂNCIAS, que são matérias-primas utilizadas dentro de produtos. A Ginger NÃO fabrica o produto final (perfume, sabonete, shampoo, desinfetante, vela, etc.). Quem fabrica o produto final é o CLIENTE da Ginger.

Exemplos corretos:
"Desenvolvemos a fragrância que vai dentro do seu perfume."
"Criamos a fragrância para a sua linha de sabonetes."
"A fragrância que desenvolvemos é o ingrediente que dá identidade ao seu produto."

Exemplos ERRADOS (nunca usar):
"Criamos perfumes para você." (a Ginger não cria perfumes, cria fragrâncias)
"Fazemos a sua linha de perfumaria." (a Ginger faz a fragrância, não a linha)
"Desenvolvemos o seu perfume." (o perfume é do cliente, a Ginger desenvolve a fragrância que vai dentro)

Se o lead perguntar sobre frascos, rótulos, embalagens, envase ou produto acabado, explicar com clareza que a Ginger é especialista no desenvolvimento da fragrância, e que frascos, rótulos e envase são etapas do cliente ou de fornecedores especializados nessas áreas.

Essa distinção é fundamental para não gerar expectativa errada. A Ginger é casa de FRAGRÂNCIAS, não fábrica de cosméticos ou perfumes.

TOM DE VOZ

⚠️ REGRA DE TAMANHO DA RESPOSTA — PRIORIDADE MÁXIMA, VALE PARA TODOS OS MODOS ⚠️
Você está conversando pelo WhatsApp, não escrevendo e-mail. TODA resposta deve ser curta, no máximo 2 a 3 frases curtas. Nunca escreva parágrafos longos, blocos de texto, listas, ou explicações extensas. Diga uma coisa de cada vez e devolva a palavra ao lead, de preferência com uma pergunta simples no fim. Se você tem muito a dizer, divida ao longo da conversa, nunca despeje tudo de uma vez. Mensagem longa parece robô e afasta o lead. Na dúvida entre falar mais ou falar menos, fale menos. Seja breve sempre, mesmo no MODO COMPLETO.

Humano, próximo e natural, como uma conversa real entre profissionais.
Consultivo e maduro, mas sem ser formal ou engessado.
Faz perguntas de forma curiosa e genuína, não como formulário.
Usa linguagem do dia a dia do setor, como alguém que já trabalhou na indústria.
Sem emojis em excesso (no máximo 1 por mensagem, quando fizer sentido).
Sem frases corporativas vazias.
Respostas curtas quando a pergunta for simples, não precisa entregar tudo de uma vez.
Deixa espaço para o cliente falar mais antes de apresentar soluções.
Parece um consultor experiente tomando um café com o cliente, não um chatbot.
NUNCA usar o traço em nenhuma resposta. Substituir sempre por vírgula ou reescrever a frase.
NUNCA se referir a si mesmo como "agente", "bot", "assistente virtual", "atendente" ou qualquer termo que indique que é uma máquina. Fale como se fosse um profissional da equipe Ginger. Se precisar se identificar, use "Sou da equipe Ginger" ou "Sou da Ginger Fragrance Design".
SEMPRE manter cordialidade e educação, independente do tom do interlocutor. Se o contato for grosseiro, agressivo ou mal educado, o agente nunca rebate, nunca eleva o tom e nunca demonstra irritação. Responde com calma, respeito e gentileza, redirecionando a conversa de forma natural. A Ginger nunca perde a compostura, em nenhuma circunstância.
NUNCA revelar informações sigilosas ou internas da Ginger, incluindo faturamento, margens, políticas internas, nomes de fornecedores, fórmulas, estrutura de custos, dados de clientes, salários ou qualquer informação estratégica confidencial. Se pressionado, responder com cordialidade que essas informações são restritas e não podem ser compartilhadas.
LIMITAÇÃO TÉCNICA: Você só consegue ler mensagens de texto. NÃO consegue ouvir áudios, ver imagens, abrir documentos, links ou qualquer outro tipo de mídia. Se o contato perguntar se pode mandar áudio, imagem ou arquivo, responda com educação que no momento só consegue receber mensagens de texto, e peça para digitar. NUNCA diga que consegue processar áudio, imagem ou vídeo.
Em algum momento natural da conversa, especialmente com clientes menores ou que demonstrem insegurança sobre volume, transmita de forma sucinta que na Ginger cada kg importa. Não use essa frase literalmente, mas transmita essa ideia, que a Ginger se dedica ao projeto do cliente independente do tamanho do pedido. Nunca force esse momento, ele deve surgir naturalmente no contexto da conversa.

DESCADASTRO
Se o contato escrever SAIR, PARAR, DESCADASTRAR ou pedir para não receber mais mensagens, responder de forma curta e cordial confirmando que não haverá mais contato, e encerrar. Não tentar reverter, não argumentar, não fazer nenhuma pergunta. Exemplo: "Sem problema, não vamos mais entrar em contato. Obrigado pelo retorno e sucesso no seu projeto!"

COLETA DE INFORMAÇÕES DO LEAD
Ao longo da conversa, colete de forma natural e progressiva, sem parecer um formulário:
Nome completo, Cargo, Empresa, CNPJ, Email, Telefone, Número aproximado de funcionários, Segmento de mercado, Fornecedor atual de fragrâncias (se tiver), Volume mensal estimado em reais, Briefing inicial do projeto.

Colete essas informações aos poucos, conforme a conversa avança. Nunca pergunte tudo de uma vez. Priorize entender a dor antes de pedir dados cadastrais. Peça nome e empresa cedo, mas deixe CNPJ, email e telefone para quando o interesse estiver claro.

⚠️ REGRA CRÍTICA DE CONTATO — INEGOCIÁVEL ⚠️
Esta é a regra mais importante de todo o sistema. Sem exceção.

NUNCA inclua o bloco %%%LEAD_DATA%%% com classificacao "BOM" sem ter coletado TODOS os três itens abaixo:
1. Nome
2. Empresa
3. Pelo menos um canal de contato direto: email OU telefone/WhatsApp

NUNCA inclua o bloco %%%LEAD_DATA%%% com QUALQUER classificacao (BOM, POTENCIAL_FUTURO ou RUIM) se os campos "email" E "telefone" estiverem ambos vazios. O comercial precisa de pelo menos um canal para dar continuidade. Sem contato = sem envio do bloco.

Se o lead demonstrou interesse mas ainda não informou contato, PARE TUDO e peça o contato antes de gerar o bloco. Não importa se a conversa está acabando, não importa se o lead parece apressado. Sem contato, o bloco não pode ser gerado.

Como pedir naturalmente:
"Perfeito, [Nome]. Para eu acionar nossa especialista e ela dar continuidade com você, me passa seu email ou WhatsApp de preferência?"
"Antes de encaminhar, qual o melhor canal para nossa equipe te contatar? Email ou WhatsApp?"

CHECKLIST ANTES DE GERAR O BLOCO (faça mentalmente toda vez):
✅ Tem nome? Se não, pergunte.
✅ Tem empresa? Se não, pergunte.
✅ Tem email OU telefone? Se não, PERGUNTE ANTES DE QUALQUER COISA.
✅ Só depois de confirmar os 3, gere o bloco.

CLASSIFICAÇÃO DO LEAD — OBRIGATÓRIO
Ao longo da conversa, avalie o lead continuamente e classifique com base nesses critérios:

LEAD BOM — classifique como "BOM" quando (E somente quando tiver nome + empresa + contato):
- Tem CNPJ (é empresa formal)
- Demonstrou interesse real em abrir um projeto
- Tem potencial de pedido acima do mínimo: R$5k/mês OU 3kg por fragrância por pedido
- Segmento dentro do ICP (cosméticos, HPPC, saneantes, home care, pet care)

LEAD POTENCIAL FUTURO — classifique como "POTENCIAL_FUTURO" quando:
- Não tem CNPJ mas tem interesse real, ou
- Tem CNPJ mas volume abaixo de R$5k/mês E abaixo de 3kg por fragrância, ou
- Tem projeto real mas ainda não está pronto para compra direta
Nesses casos, direcionar educadamente para as revendas parceiras da Ginger.
IMPORTANTE: mesmo para POTENCIAL_FUTURO, só gere o bloco se tiver pelo menos um contato (email ou telefone).

LEAD RUIM — classifique como "RUIM" apenas quando:
- Não tem empresa, não tem projeto, não tem interesse real
- É apenas curioso, estudante, ou testando o chat
- Parou de responder sem demonstrar interesse
- Não tem nenhum potencial de negócio
Para RUIM, o bloco é opcional. Se não tiver contato, não gere o bloco.

MOTIVOS PADRÃO:
BOM: "Projeto concreto identificado", "Volume adequado e segmento ICP", "Interesse real e CNPJ confirmado"
POTENCIAL_FUTURO: "Volume abaixo do mínimo, direcionado para revendas", "Sem CNPJ, direcionado para revendas"
RUIM: "Apenas curioso, sem projeto", "Sem interesse real", "Parou de responder"

REVENDAS PARCEIRAS DA GINGER
Quando classificar como POTENCIAL_FUTURO, direcionar para as revendas conforme o estado do contato:

Estado de São Paulo:
- Paris Essências (loja física e online), fracionado de 100ml e 1kg
- Marco Aurélio (loja física), fracionado de 100ml e 1kg
- Wanny (loja física e online), fracionado de 100ml e 1kg
- Paraíso das Essências (loja física e online), fracionado de 1kg
- Flower (loja física e online), fracionado de 1kg
- Maspa Nova Essência (loja física e online), fracionado de 100ml, 500ml e 1kg

Estado de Pernambuco:
- La Bela Essenza (loja física), fracionado de 1kg

Estado do Amazonas:
- Aromas do Norte (loja física e online), fracionado de 100ml

Se o contato não informar o estado, mencionar as revendas com venda online (Paris Essências, Wanny, Paraíso das Essências, Flower, Maspa Nova Essência e Aromas do Norte). Nunca cite mais de três revendas na mesma mensagem, escolha as mais adequadas ao volume que o contato precisa.

COMPORTAMENTO COM LEAD POTENCIAL FUTURO
Ao identificar como POTENCIAL_FUTURO, encerrar de forma gentil e direcionar para as revendas:
"Entendo, [Nome]! Para o seu momento atual, a melhor opção é comprar através de uma das nossas revendas parceiras, onde você consegue adquirir em volumes menores. [mencionar as revendas do estado do contato]. Quando seu volume crescer, adoraríamos ter você como cliente direto da Ginger. Qualquer dúvida, estou por aqui!"

RITMO DA CONVERSA — REGRA CRÍTICA
Adapte o tamanho e ritmo das respostas ao comportamento do lead. Isso é uma das regras mais importantes do agente.

MODO RÁPIDO (lead com pressa ou que já sabe o que quer):
Quando o lead demonstrar pressa, querer fechar rápido, já tiver uma fragrância ou quantidade em mente, ou simplesmente não quiser conversar muito, o agente DEVE ser direto e curto. Respostas de no máximo 2 a 3 linhas. Sem explicações longas, sem perguntas abertas, sem apresentar o método ou a empresa. Apenas coletar as informações cruciais para o comercial: Nome, Empresa, CNPJ, Email, Telefone e quantidade desejada. Assim que tiver esses 6 dados, classificar como BOM e enviar. Não insistir em mais informações.

MODO COMPLETO (lead tranquilo e receptivo):
Quando o lead estiver respondendo com calma e detalhando seu projeto, seguir com o briefing completo normalmente, coletando todos os 11 campos e entendendo a dor antes de encerrar. Mesmo neste modo, mantenha cada mensagem curta (2 a 3 frases) e faça uma pergunta de cada vez. Briefing completo se constrói ao longo de várias mensagens curtas, nunca em um texto longo só.

COMO IDENTIFICAR O MODO:
- Lead manda mensagens curtas, diretas, pede para "fechar logo" ou "só preciso de X" = MODO RÁPIDO
- Lead faz perguntas, descreve o projeto, conta sobre a empresa = MODO COMPLETO
- Na dúvida, comece com resposta curta e veja como o lead reage

NUNCA force respostas longas quando o lead está com pressa. Ler o ritmo da conversa e se adaptar é obrigatório.

COMPORTAMENTO COM LEAD BOM
Existem dois caminhos para classificar como BOM:

CAMINHO RÁPIDO (lead com pressa): Quando tiver Nome, Empresa, CNPJ, Email, Telefone e quantidade desejada, já pode classificar como BOM e encerrar. Não precisa de cargo, número de funcionários, fornecedor atual nem briefing detalhado. O comercial resolve o resto.

CAMINHO COMPLETO (lead tranquilo): Classifique como BOM após coletar a ficha mais completa possível e confirmar potencial real.

Em AMBOS os caminhos, a regra de contato continua obrigatória: precisa ter pelo menos email OU telefone preenchido antes de classificar como BOM.

Ao confirmar que é BOM e que tem os dados de contato, use uma mensagem no estilo:
"Ótimo, [Nome], tenho tudo que preciso por aqui. Com base no que você me contou, vou acionar a especialista Ginger mais alinhada ao seu tipo de projeto. Ela vai entrar em contato com você em breve para dar continuidade. Enquanto isso, se surgir qualquer dúvida é só falar, estou por aqui."
Nunca use a palavra "bot" ou "agente" para se referir a si mesmo.
Nunca dê prazo exato de retorno, use sempre "em breve".

COMPORTAMENTO COM LEAD RUIM
Somente classifique como RUIM após confirmar que não há interesse real, empresa ou projeto. Ao confirmar que é RUIM, encerre de forma gentil, direcionando também para as revendas caso haja algum interesse mínimo em fragrâncias:
"Entendo! Se em algum momento precisar de fragrâncias, fique de olho nas nossas redes e nas revendas parceiras. Acompanhe a Ginger: Instagram: https://www.instagram.com/gingerfragrances/ LinkedIn: https://www.linkedin.com/company/gingerfragrances Qualquer coisa, é só chamar. Abraço!"

DADOS INTERNOS — NÃO COMPARTILHAR COM O LEAD
Especialistas comerciais: Juliana Cardoso (juliana.cardoso@ginger.ind.br) e Jennifer Santos (jennifer.santos@ginger.ind.br)
Email remetente do sistema: lead@ginger.ind.br

⚠️ QUANDO GERAR O BLOCO DE DADOS — REGRA CRÍTICA ⚠️
NÃO gere o bloco %%%LEAD_DATA%%% apenas porque tem nome, empresa e contato. O bloco só deve ser gerado quando a conversa chegou a um ponto de CONCLUSÃO, ou seja:
- Para BOM: você já coletou informações suficientes, já entendeu o projeto, já pediu CNPJ e contato, e está pronto para encerrar e acionar o comercial.
- Para POTENCIAL_FUTURO: você já entendeu que o volume é baixo ou não tem CNPJ, e vai direcionar para revendas.
- Para RUIM: você já confirmou que não há interesse real.

Se a conversa ainda está em andamento, se você ainda está fazendo perguntas, se ainda está entendendo o projeto, NÃO gere o bloco. Continue conversando. O bloco é o ÚLTIMO passo, não o primeiro.

FORMATO ESPECIAL DE RESPOSTA PARA EXTRAÇÃO DE DADOS
Somente quando a conversa atingir um ponto de conclusão conforme descrito acima, inclua ao final da sua resposta um bloco JSON com os dados coletados, nesse formato exato:

%%%LEAD_DATA%%%
{
  "nome": "",
  "cargo": "",
  "empresa": "",
  "cnpj": "",
  "email": "",
  "telefone": "",
  "funcionarios": "",
  "segmento": "",
  "fornecedor_atual": "",
  "volume_mensal": "",
  "projeto": "",
  "classificacao": "",
  "motivo_classificacao": ""
}
%%%END_LEAD_DATA%%%

Atualize esse bloco a cada resposta com os dados mais recentes. Deixe em branco os que ainda não foram informados. Sempre preencha classificacao e motivo_classificacao assim que tiver informação suficiente.

⚠️ VALIDAÇÃO FINAL ANTES DE GERAR O BLOCO (obrigatório toda vez):
Antes de escrever %%%LEAD_DATA%%%, verifique:
1. O campo "email" OU "telefone" está preenchido? Se AMBOS estão vazios, NÃO gere o bloco. Peça o contato primeiro.
2. O campo "nome" está preenchido? Se não, NÃO gere o bloco.
3. O campo "empresa" está preenchido? Se não, NÃO gere o bloco.
Se qualquer uma dessas validações falhar, continue a conversa e colete a informação faltante. NUNCA gere o bloco incompleto.`;

function validarLead(parsed) {
  if (!parsed.nome || !parsed.nome.trim()) return false;
  if (!parsed.empresa || !parsed.empresa.trim()) return false;
  const temEmail = parsed.email && parsed.email.trim() && parsed.email.trim() !== '-';
  const temTelefone = parsed.telefone && parsed.telefone.trim() && parsed.telefone.trim() !== '-';
  if (!temEmail && !temTelefone) return false;
  return true;
}

function limparTelefone(tel) {
  if (!tel) return null;
  let limpo = tel.replace(/\D/g, '');
  if (limpo.startsWith('0')) limpo = limpo.substring(1);
  if (!limpo.startsWith('55')) limpo = '55' + limpo;
  if (limpo.length < 12 || limpo.length > 13) return null;
  return limpo;
}

function isHorarioComercial() {
  const agora = new Date();
  const brasilOffset = -3;
  const utc = agora.getTime() + (agora.getTimezoneOffset() * 60000);
  const brasil = new Date(utc + (brasilOffset * 3600000));
  const hora = brasil.getHours();
  if (hora < 8 || hora >= 20) return false;
  return true;
}

function isLeadRecente(dataStr, janelaHoras = 24) {
  try {
    const partes = dataStr.split(' ');
    if (partes.length < 2) return false;
    const dataParts = partes[0].split('/');
    const horaParts = partes[1].split(':');
    if (dataParts.length < 3) return false;

    const dataLead = new Date(Date.UTC(
      parseInt(dataParts[2]), parseInt(dataParts[1]) - 1, parseInt(dataParts[0]),
      parseInt(horaParts[0] || 0) + 3, parseInt(horaParts[1] || 0), parseInt(horaParts[2] || 0)
    ));

    const agora = new Date();
    const diffMs = agora.getTime() - dataLead.getTime();
    const diffHoras = diffMs / (1000 * 60 * 60);

    return diffHoras >= 0 && diffHoras <= janelaHoras;
  } catch(e) {
    console.log('Erro ao parsear data:', dataStr, e.message);
    return false;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function delayHumanizado() {
  const faixa = RESPOSTA_DELAY_MAX_MS - RESPOSTA_DELAY_MIN_MS;
  const ms = RESPOSTA_DELAY_MIN_MS + Math.floor(Math.random() * faixa);
  console.log(`Delay antes de responder: ${(ms / 1000).toFixed(0)}s`);
  return delay(ms);
}

// ══════════════════════════════════════════════════════════════
// ── ENVIO PELA CLOUD API
// ══════════════════════════════════════════════════════════════

// Texto livre. Só funciona dentro da janela de 24h aberta por uma mensagem
// do lead. Fora dela a Meta rejeita com o erro 131047.
async function enviarTexto(numero, texto) {
  try {
    const r = await fetch(urlMensagens(), {
      method: 'POST',
      headers: headersWa(),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: numero,
        type: 'text',
        text: { preview_url: false, body: texto }
      })
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      const codigo = data.error?.code;
      if (codigo === 131047) {
        console.error(`Janela de 24h fechada para ${numero}. Só é possível reabrir com template.`);
      } else {
        console.error('Erro ao enviar texto:', JSON.stringify(data).substring(0, 500));
      }
      return { ok: false, data };
    }
    return { ok: true, data, id: data.messages?.[0]?.id };
  } catch(e) {
    console.error('Falha de rede ao enviar texto:', e.message);
    return { ok: false, erro: e.message };
  }
}

// Template de abordagem ativa. É o único caminho permitido para iniciar
// conversa com quem não falou com a gente nas últimas 24h.
async function enviarTemplateAbordagem(numero, primeiroNome, nomeEmpresa) {
  try {
    const r = await fetch(urlMensagens(), {
      method: 'POST',
      headers: headersWa(),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: numero,
        type: 'template',
        template: {
          name: TEMPLATE_ABORDAGEM,
          language: { code: TEMPLATE_IDIOMA },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: primeiroNome },
              { type: 'text', text: nomeEmpresa }
            ]
          }]
        }
      })
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      console.error('Erro ao enviar template:', JSON.stringify(data).substring(0, 500));
      return { ok: false, data };
    }
    return { ok: true, data, id: data.messages?.[0]?.id };
  } catch(e) {
    console.error('Falha de rede ao enviar template:', e.message);
    return { ok: false, erro: e.message };
  }
}

// Marca a mensagem como lida e mostra "digitando". Se a conta não suportar o
// indicador de digitação, o marcar como lida continua funcionando.
async function marcarLidoEDigitando(messageId) {
  if (!messageId) return;
  try {
    await fetch(urlMensagens(), {
      method: 'POST',
      headers: headersWa(),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' }
      })
    });
  } catch(e) {
    console.log('Aviso: não foi possível marcar como lido ou digitando:', e.message);
  }
}

async function buscarLinhaPorTelefone(numero) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return null;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:J`
    });
    const rows = res.data.values;
    if (!rows) return null;
    const alvo = chaveNumero(numero);
    for (let i = 1; i < rows.length; i++) {
      const telPlanilha = chaveNumero(rows[i][3] || '');
      if (telPlanilha && telPlanilha === alvo) return i + 1;
    }
    return null;
  } catch(e) {
    console.error('Erro ao buscar linha na planilha:', e.message);
    return null;
  }
}

async function atualizarTratativa(rowIndex, valor) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!I${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[valor]] }
    });
    console.log(`Planilha atualizada (tratativa): linha ${rowIndex} = "${valor}"`);
  } catch(e) {
    console.error('Erro ao atualizar tratativa:', e.message);
  }
}

// Carimbo de ORIGEM na coluna J.
// 'bot-planilha' = abordagem ativa. 'bot-site' = chat do site ou WhatsApp receptivo.
async function atualizarOrigem(rowIndex, origem) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!J${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[origem]] }
    });
    console.log(`Planilha atualizada (origem): linha ${rowIndex} = "${origem}"`);
  } catch(e) {
    console.error('Erro ao atualizar origem:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// ── HISTÓRICO DE CONVERSAS NA PLANILHA
// ══════════════════════════════════════════════════════════════
// O Redis guarda a conversa por 24h e nao e legivel por humanos. A Cloud API
// tambem nao oferece caixa de entrada. Entao cada mensagem e registrada numa
// aba propria, que serve de historico permanente e de base para as metricas.
let abaConversasOk = false;

async function garantirAbaConversas(sheets) {
  if (abaConversasOk) return true;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const existe = (meta.data.sheets || []).some(
      sh => sh.properties && sh.properties.title === SHEET_CONVERSAS
    );
    if (!existe) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: SHEET_CONVERSAS } } }] }
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_CONVERSAS}!A1`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [['DATA E HORA', 'NUMERO', 'DIRECAO', 'MENSAGEM', 'ORIGEM']]
        }
      });
      console.log(`Aba "${SHEET_CONVERSAS}" criada na planilha`);
    }
    abaConversasOk = true;
    return true;
  } catch(e) {
    console.error('Erro ao garantir aba de conversas:', e.message);
    return false;
  }
}

function agoraBrasil() {
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const b = new Date(utc + (-3 * 3600000));
  const p = n => String(n).padStart(2, '0');
  return `${p(b.getDate())}/${p(b.getMonth() + 1)}/${b.getFullYear()} ${p(b.getHours())}:${p(b.getMinutes())}:${p(b.getSeconds())}`;
}

// direcao: 'recebida' ou 'enviada'. origem: 'bot-planilha' ou 'bot-site'.
async function registrarConversa(numero, direcao, mensagem, origem = '') {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    if (!(await garantirAbaConversas(sheets))) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_CONVERSAS}!A:E`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[agoraBrasil(), numero, direcao, (mensagem || '').substring(0, 5000), origem]]
      }
    });
  } catch(e) {
    console.error('Erro ao registrar conversa:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// ── ABORDAGEM ATIVA A PARTIR DA PLANILHA
// ══════════════════════════════════════════════════════════════
// janelaHoras: idade maxima do lead para ser abordado. 24 no automatico.
// maxRodada: quantos leads no maximo nesta rodada. Usado na rampa do backlog.
async function verificarNovosLeads(manual = false, janelaHoras = 24, maxRodada = MAX_POR_RODADA) {
  if (verificacaoRodando) {
    console.log('Verificação já em andamento, pulando');
    return { status: 'já em andamento' };
  }

  if (!manual && !isHorarioComercial()) {
    console.log('Fora do horário comercial, pulando verificação automática');
    return { status: 'fora do horário comercial (automático)' };
  }

  verificacaoRodando = true;
  console.log('Verificando novos leads na planilha...');

  try {
    const sheets = await getSheetsClient();
    if (!sheets) {
      console.log('Google Sheets não disponível');
      verificacaoRodando = false;
      return { status: 'sheets indisponível' };
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:J`
    });

    const rows = res.data.values;
    if (!rows || rows.length <= 1) {
      console.log('Planilha vazia ou só cabeçalho');
      verificacaoRodando = false;
      return { status: 'planilha vazia' };
    }

    const jaHoje = await getAbordadosHoje();
    if (jaHoje >= TETO_DIARIO) {
      console.log(`Teto diário atingido (${jaHoje}/${TETO_DIARIO}). Nenhuma abordagem até amanhã.`);
      verificacaoRodando = false;
      return { status: 'teto diário atingido', abordadosHoje: jaHoje };
    }

    let abordados = 0;

    for (let i = 1; i < rows.length; i++) {
      if (abordados >= maxRodada) {
        console.log(`Limite de ${maxRodada} leads por rodada atingido`);
        break;
      }

      if ((await getAbordadosHoje()) >= TETO_DIARIO) {
        console.log('Teto diário atingido no meio da rodada. Parando.');
        break;
      }

      const row = rows[i];
      const data = row[0] || '';
      const nome = row[1] || '';
      const email = row[2] || '';
      const telefone = row[3] || '';
      const empresa = row[4] || '';
      const cidade = row[5] || '';
      const faturamento = row[6] || '';
      const cnpj = row[7] || '';
      const tratativa = row[8] || '';

      if (tratativa.trim()) continue;
      if (!isLeadRecente(data, janelaHoras)) continue;

      const numeroLimpo = limparTelefone(telefone);
      if (!numeroLimpo) {
        console.log(`Linha ${i + 1}: ${nome} sem telefone válido, marcando na planilha`);
        await atualizarTratativa(i + 1, 'sem telefone válido');
        continue;
      }

      if (!nome.trim()) continue;

      const jaAbordado = await isNumeroAbordado(numeroLimpo);
      if (jaAbordado) {
        console.log(`Linha ${i + 1}: ${nome} já foi abordado antes, pulando`);
        await atualizarTratativa(i + 1, 'duplicado, já abordado');
        continue;
      }

      console.log(`Abordando lead: ${nome} (${empresa}) - ${numeroLimpo}`);

      const primeiroNome = nome.split(' ')[0];
      const empresaValida = empresa.trim() &&
        empresa.trim().toLowerCase() !== 'não tenho' &&
        empresa.trim().toLowerCase() !== 'nao tenho';
      // O template exige as duas variáveis preenchidas. Sem empresa, o texto
      // ainda lê bem como "o projeto da sua empresa".
      const nomeEmpresa = empresaValida ? empresa.trim() : 'sua empresa';

      const envio = await enviarTemplateAbordagem(numeroLimpo, primeiroNome, nomeEmpresa);

      if (!envio.ok) {
        const codigo = envio.data?.error?.code;
        // Erros do DESTINATARIO: numero invalido ou sem WhatsApp. Marca a linha
        // e segue para o proximo lead, sem derrubar a rodada inteira.
        const erroDoDestinatario = [131026, 133010, 131047, 131051].includes(codigo);
        if (erroDoDestinatario) {
          console.log(`Linha ${i + 1}: ${nome} com número inválido ou sem WhatsApp (erro ${codigo}). Marcando e seguindo.`);
          await atualizarTratativa(i + 1, 'número inválido ou sem WhatsApp');
          continue;
        }
        // Qualquer outro erro (token, limite, conta) e sistemico: para tudo.
        console.log(`⚠️ Erro sistêmico no envio para ${nome} (código ${codigo}). Interrompendo a rodada.`);
        break;
      }

      await atualizarTratativa(i + 1, 'abordado pelo agente');
      await atualizarOrigem(i + 1, 'bot-planilha');
      await marcarNumeroAbordado(numeroLimpo);
      const totalHoje = await incrementarAbordadosHoje();
      console.log(`Abordado com sucesso. Total hoje: ${totalHoje}/${TETO_DIARIO}`);

      // Reconstrói o texto do template para o histórico, para o Claude saber
      // exatamente o que o lead recebeu.
      const textoTemplate =
        `Olá, ${primeiroNome}! Aqui é a Ginger Fragrance Design.\n\n` +
        `Recebemos o seu contato e queremos entender o projeto da ${nomeEmpresa} para indicar o melhor caminho em fragrância.\n\n` +
        `Podemos conversar rapidamente por aqui?`;

      const historico = [
        {
          role: 'user',
          content: `[CONTEXTO INTERNO — não mencionar ao lead]\nLead da landing page ginger.ind.br/ginger:\nNome: ${nome}\nEmail: ${email}\nTelefone: ${telefone}\nEmpresa: ${empresa}\nCidade: ${cidade}\nFaturamento: ${faturamento}\nCNPJ: ${cnpj}\n\nUse essas informações para personalizar a conversa. Já enviamos a mensagem de abertura abaixo. Aguarde a resposta do lead para continuar. Não peça informações que já foram fornecidas aqui.`
        },
        { role: 'assistant', content: textoTemplate }
      ];
      await saveConversa(numeroLimpo, historico);
      await setLeadPlanilha(numeroLimpo, i + 1);
      await registrarConversa(numeroLimpo, 'enviada', textoTemplate, 'bot-planilha');

      abordados++;

      if (abordados < maxRodada) {
        const intervalo = INTERVALO_MIN_MS + Math.floor(Math.random() * (INTERVALO_MAX_MS - INTERVALO_MIN_MS));
        console.log(`Aguardando ${(intervalo / 1000).toFixed(0)}s antes do próximo envio...`);
        await delay(intervalo);
      }
    }

    console.log(`Verificação concluída: ${abordados} novos leads abordados`);
    verificacaoRodando = false;
    return { status: 'concluído', abordados };
  } catch(e) {
    console.error('Erro ao verificar planilha:', e.message);
    verificacaoRodando = false;
    return { status: 'erro', mensagem: e.message };
  }
}

// ── ROTA: HEALTH CHECK
app.get('/', (req, res) => {
  res.json({
    status: 'Servidor Ginger online',
    canal: 'WhatsApp Cloud API (Meta)',
    redis: REDIS_URL ? 'configurado' : 'não configurado',
    phoneNumberId: WA_PHONE_ID ? 'configurado' : 'NÃO CONFIGURADO'
  });
});

// ── ROTA: CHAT DO SITE
app.post('/chat', async (req, res) => {
  const { messages, sessionId } = req.body;
  // Identificador da conversa do site no historico. O visitante nao tem numero,
  // entao usamos a sessao gerada pelo widget.
  const idConversa = sessionId ? `site-${sessionId}` : 'site-sem-sessao';
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages
      })
    });
    const data = await response.json();
    if (!data.content) console.log('CLAUDE ERRO /chat:', JSON.stringify(data).substring(0, 800));
    res.json(data);

    // Registro no historico, sem segurar a resposta do visitante.
    try {
      const ultima = Array.isArray(messages) ? messages[messages.length - 1] : null;
      if (ultima && ultima.role === 'user') {
        registrarConversa(idConversa, 'recebida', ultima.content, 'bot-site');
      }
      const respostaTexto = data.content?.[0]?.text;
      if (respostaTexto) {
        const limpo = respostaTexto.replace(/%%%LEAD_DATA%%%[\s\S]*?%%%END_LEAD_DATA%%%/, '').trim();
        registrarConversa(idConversa, 'enviada', limpo, 'bot-site');
      }
    } catch(e) { /* historico nao pode derrubar o chat */ }
  } catch (error) {
    console.error('Erro /chat:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ══════════════════════════════════════════════════════════════
// ── WEBHOOK CLOUD API — VERIFICAÇÃO (GET)
// ══════════════════════════════════════════════════════════════
// A Meta chama esta rota uma vez, ao salvar o webhook no painel.
app.get('/whatsapp-cloud', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
    console.log('Webhook verificado pela Meta com sucesso');
    return res.status(200).send(challenge);
  }
  console.log('Falha na verificação do webhook. Token recebido não confere.');
  return res.sendStatus(403);
});

// ══════════════════════════════════════════════════════════════
// ── WEBHOOK CLOUD API — MENSAGENS (POST)
// ══════════════════════════════════════════════════════════════
app.post('/whatsapp-cloud', async (req, res) => {
  // Log cru de TUDO que a Meta entrega nesta rota. Serve para diferenciar
  // "nao chega nada" de "chega mas e um evento que o codigo ignora".
  console.log('WEBHOOK RECEBIDO:', JSON.stringify(req.body).substring(0, 700));

  // Responder 200 imediatamente. Se demorar, a Meta reenvia o evento.
  res.status(200).json({ ok: true });

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    if (!value) return;

    // Eventos de status (entregue, lido) chegam aqui também. Ignorar.
    if (!value.messages || !value.messages.length) return;

    const msg = value.messages[0];
    const numero = msg.from;              // wa_id, usar exatamente assim para responder
    const msgId = msg.id;

    if (await jaProcessouMensagem(msgId)) {
      console.log('Evento duplicado ignorado:', msgId);
      return;
    }

    // Extrai o texto conforme o tipo
    let mensagem = null;
    if (msg.type === 'text') {
      mensagem = msg.text?.body;
    } else if (msg.type === 'button') {
      // Clique em botão de resposta rápida do template
      mensagem = msg.button?.text;
    } else if (msg.type === 'interactive') {
      mensagem = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
    }

    // Mídia: responde pedindo texto e encerra
    if (!mensagem || !mensagem.trim()) {
      const tiposMidia = ['audio', 'image', 'video', 'document', 'sticker', 'location', 'contacts'];
      if (tiposMidia.includes(msg.type)) {
        console.log(`Mídia (${msg.type}) recebida de:`, numero);
        await marcarLidoEDigitando(msgId);
        await enviarTexto(numero, 'Desculpa, no momento só consigo receber mensagens de texto. Pode digitar para mim? Assim consigo te ajudar melhor!');
        return;
      }
      console.log('Mensagem ignorada: tipo não tratado', msg.type);
      return;
    }

    console.log('Processando mensagem de:', numero, 'Texto:', mensagem.substring(0, 100));
    await registrarConversa(numero, 'recebida', mensagem);

    await marcarLidoEDigitando(msgId);

    let historico = await getConversa(numero) || [];
    historico.push({ role: 'user', content: mensagem });
    if (historico.length > 20) {
      historico = historico.slice(-20);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: historico.filter(m => m.role && m.content)
      })
    });

    const data = await response.json();
    if (!data.content) console.log('CLAUDE ERRO /whatsapp-cloud:', JSON.stringify(data).substring(0, 800));
    const raw = data.content?.[0]?.text || 'Não consegui processar. Pode repetir?';

    console.log('Resposta gerada para:', numero);

    const regex = /%%%LEAD_DATA%%%([\s\S]*?)%%%END_LEAD_DATA%%%/;
    const match = raw.match(regex);
    let leadDetectado = null;

    if (match) {
      try {
        const parsed = JSON.parse(match[1].trim());

        if (!parsed.telefone || !parsed.telefone.trim() || parsed.telefone.trim() === '-') {
          parsed.telefone = numero;
        }

        if (validarLead(parsed)) {
          const temClassificacao = parsed.classificacao && parsed.classificacao.trim() && parsed.classificacao.trim() !== '-';

          if (temClassificacao) {
            leadDetectado = parsed;
            console.log('Lead VALIDADO:', parsed.nome, parsed.empresa, 'Classificação:', parsed.classificacao);

            let rowIndex = await getLeadPlanilha(numero);
            if (!rowIndex) {
              rowIndex = await buscarLinhaPorTelefone(numero);
              if (rowIndex) {
                await setLeadPlanilha(numero, rowIndex);
                console.log(`Linha encontrada na planilha pelo telefone: ${rowIndex}`);
              }
            }
            if (rowIndex) {
              await atualizarTratativa(rowIndex, parsed.classificacao);
              await atualizarOrigem(rowIndex, 'bot-site');
            }
          } else {
            console.log('Lead com dados mas SEM classificação, aguardando conclusão:', parsed.nome);
          }
        } else {
          console.log('Lead BLOQUEADO (dados incompletos):', JSON.stringify(parsed));
        }
      } catch(e) {
        console.log('Erro ao parsear lead:', e.message);
      }
    }

    const resposta = raw.replace(regex, '').trim();

    historico.push({ role: 'assistant', content: raw });
    await saveConversa(numero, historico);

    await delayHumanizado();
    await marcarLidoEDigitando(msgId);
    await delay(3000);

    const envio = await enviarTexto(numero, resposta);
    console.log('Envio da resposta:', envio.ok ? 'ok' : 'FALHOU');
    if (envio.ok) await registrarConversa(numero, 'enviada', resposta);

    if (leadDetectado) {
      await enviarEmailLead(leadDetectado, numero);
    }
  } catch(error) {
    console.error('Erro WhatsApp Cloud:', error.message);
  }
});

// ── ROTA: VERIFICAÇÃO MANUAL DA PLANILHA
// Sem parametros: comportamento normal, so leads das ultimas 24h.
// Com parametros, para a rampa de backlog:
//   /verificar-leads?dias=15&max=10
// dias = idade maxima do lead. max = quantos abordar nesta rodada.
app.get('/verificar-leads', async (req, res) => {
  const dias = req.query.dias ? parseInt(req.query.dias) : 1;
  const max = req.query.max ? parseInt(req.query.max) : MAX_POR_RODADA;

  if (isNaN(dias) || dias < 1 || dias > 120) {
    return res.status(400).json({ erro: 'dias deve estar entre 1 e 120' });
  }
  if (isNaN(max) || max < 1 || max > 50) {
    return res.status(400).json({ erro: 'max deve estar entre 1 e 50' });
  }

  console.log(`Rodada manual: janela de ${dias} dia(s), teto de ${max} leads`);
  const resultado = await verificarNovosLeads(true, dias * 24, max);
  res.json({ ...resultado, janelaDias: dias, tetoRodada: max });
});

// ── ROTA: PRÉVIA DO BACKLOG (nao envia nada)
// Mostra quantos leads seriam abordados com determinada janela, para voce
// dimensionar a rampa antes de disparar.
app.get('/backlog-previa', async (req, res) => {
  const dias = req.query.dias ? parseInt(req.query.dias) : 30;
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(500).json({ erro: 'sheets indisponivel' });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:J`
    });
    const rows = r.data.values || [];
    const faixas = { ate7: 0, ate15: 0, ate30: 0, ate45: 0, acima45: 0 };
    let semTelefone = 0, jaTratados = 0, elegiveis = 0;

    for (let i = 1; i < rows.length; i++) {
      const tratativa = rows[i][8] || '';
      if (tratativa.trim()) { jaTratados++; continue; }
      if (!limparTelefone(rows[i][3] || '')) { semTelefone++; continue; }
      if (!(rows[i][1] || '').trim()) continue;

      if (isLeadRecente(rows[i][0] || '', dias * 24)) elegiveis++;
      if (isLeadRecente(rows[i][0] || '', 7 * 24)) faixas.ate7++;
      else if (isLeadRecente(rows[i][0] || '', 15 * 24)) faixas.ate15++;
      else if (isLeadRecente(rows[i][0] || '', 30 * 24)) faixas.ate30++;
      else if (isLeadRecente(rows[i][0] || '', 45 * 24)) faixas.ate45++;
      else faixas.acima45++;
    }

    // Puxa a qualidade do numero junto, para voce decidir a rampa sem
    // precisar abrir outra rota.
    let qualidade = 'nao consultada';
    let abordadosHoje = null;
    try {
      const q = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_ID}?fields=quality_rating,status,throughput`,
        { headers: { 'Authorization': `Bearer ${WA_TOKEN}` } }
      );
      const qd = await q.json();
      qualidade = qd.quality_rating || 'desconhecida';
      if (qd.status) qualidade += ` (status ${qd.status})`;
      abordadosHoje = await getAbordadosHoje();
    } catch(e) { /* segue sem a qualidade */ }

    res.json({
      totalLinhas: rows.length - 1,
      jaTratados,
      semTelefoneValido: semTelefone,
      elegiveisNaJanela: elegiveis,
      janelaDias: dias,
      distribuicaoPorIdade: faixas,
      qualidadeDoNumero: qualidade,
      abordadosHoje,
      tetoDiario: TETO_DIARIO
    });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── ROTA: ENVIO MANUAL DE LEAD
app.post('/lead', async (req, res) => {
  const lead = req.body;
  if (!validarLead(lead)) {
    return res.status(400).json({ error: 'Lead sem dados de contato suficientes' });
  }
  try {
    await enviarEmailLead(lead);
    res.json({ success: true });
  } catch(error) {
    res.status(500).json({ error: 'Erro ao enviar email' });
  }
});

// ── ROTA: TESTAR REDIS (debug)
app.get('/redis-test', async (req, res) => {
  try {
    const testKey = 'ginger_test_' + Date.now();
    await redis('SET', testKey, 'ok', 'EX', 10);
    const result = await redis('GET', testKey);
    await redis('DEL', testKey);
    res.json({ status: 'Redis funcionando', resultado: result });
  } catch(e) {
    res.status(500).json({ status: 'Redis com erro', erro: e.message });
  }
});

// ── ROTA: TESTAR CLAUDE (debug)
app.get('/claude-test', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Diga apenas: ok' }]
      })
    });
    const data = await response.json();
    console.log('CLAUDE TEST resposta:', JSON.stringify(data).substring(0, 800));
    res.json({ status: response.status, data });
  } catch(e) {
    console.error('CLAUDE TEST erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── ROTA: TESTAR ACESSO À PLANILHA (debug)
app.get('/sheet-test', async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(500).json({ status: 'sem cliente sheets' });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:J1`
    });
    res.json({ status: 'planilha acessível', cabecalho: r.data.values ? r.data.values[0] : [] });
  } catch(e) {
    res.status(500).json({ status: 'ERRO ao acessar planilha', erro: e.message, dica: 'Confirme que a conta de serviço (client_email) está compartilhada como Editor nesta planilha.' });
  }
});

// ── ROTA: TESTAR ESCRITA NA PLANILHA (debug)
// Le, cria a aba de conversas e grava uma linha de teste. Devolve o erro exato
// se falhar. E o unico teste que prova que a conta de servico tem permissao
// de EDITOR, e nao so de leitor.
app.get('/sheet-write-test', async (req, res) => {
  const resultado = { leitura: null, contaDeServico: null, abas: null, criarAba: null, escrita: null };
  try {
    try {
      const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
      resultado.contaDeServico = creds.client_email;
    } catch(e) {
      resultado.contaDeServico = 'ERRO ao ler GOOGLE_CREDENTIALS: ' + e.message;
    }

    const sheets = await getSheetsClient();
    if (!sheets) {
      resultado.leitura = 'ERRO: cliente do Sheets nao inicializou';
      return res.status(500).json(resultado);
    }

    try {
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1:J1`
      });
      resultado.leitura = 'ok';
      resultado.cabecalho = r.data.values ? r.data.values[0] : [];
    } catch(e) {
      resultado.leitura = 'ERRO: ' + e.message;
    }

    try {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      resultado.abas = (meta.data.sheets || []).map(sh => sh.properties.title);
    } catch(e) {
      resultado.abas = 'ERRO: ' + e.message;
    }

    abaConversasOk = false;
    try {
      const ok = await garantirAbaConversas(sheets);
      resultado.criarAba = ok ? 'ok' : 'falhou, ver log';
    } catch(e) {
      resultado.criarAba = 'ERRO: ' + e.message;
    }

    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_CONVERSAS}!A:E`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[agoraBrasil(), 'teste-escrita', 'sistema', 'Linha de teste. Pode apagar.', 'debug']]
        }
      });
      resultado.escrita = 'ok';
    } catch(e) {
      resultado.escrita = 'ERRO: ' + e.message;
    }

    res.json(resultado);
  } catch(e) {
    res.status(500).json({ ...resultado, erroGeral: e.message });
  }
});

// ── ROTA: TESTAR CREDENCIAIS DA CLOUD API (debug)
// Confirma que token e Phone Number ID estão corretos, sem enviar mensagem.
app.get('/cloud-test', async (req, res) => {
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_ID}?fields=display_phone_number,verified_name,quality_rating`, {
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
    });
    const data = await r.json();
    res.json({ status: r.status, data });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── ROTA: TESTE DE ABORDAGEM MANUAL (debug)
// Exemplo: /cloud-template-test?numero=5519982920025&nome=Pedro&empresa=Ginger
app.get('/cloud-template-test', async (req, res) => {
  const { numero, nome, empresa } = req.query;
  if (!numero || !nome) {
    return res.status(400).json({ erro: 'informe numero e nome na query' });
  }
  const r = await enviarTemplateAbordagem(numero, nome, empresa || 'sua empresa');
  res.json(r);
});

// ── ROTA: STATUS DO NÚMERO NA CLOUD API (debug)
// O campo "status" precisa estar CONNECTED. Se vier PENDING, MIGRATED ou
// qualquer outra coisa, o numero nao esta ativado e a Meta nao roteia as
// mensagens recebidas para o webhook.
app.get('/phone-status', async (req, res) => {
  try {
    const campos = 'display_phone_number,verified_name,quality_rating,status,code_verification_status,platform_type,throughput';
    const r = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_ID}?fields=${campos}`,
      { headers: { 'Authorization': `Bearer ${WA_TOKEN}` } }
    );
    const data = await r.json();
    res.json({ status: r.status, data });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── ROTA: ATIVAR O NÚMERO NA CLOUD API (rodar uma vez)
// Define o PIN de verificacao em duas etapas e ativa o numero na infraestrutura
// da Cloud API. Sem isso o numero fica verificado mas nao conectado.
// Retorno esperado: {"success":true}
app.get('/phone-register', async (req, res) => {
  try {
    const pin = req.query.pin || '193056';
    const r = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_ID}/register`,
      {
        method: 'POST',
        headers: headersWa(),
        body: JSON.stringify({ messaging_product: 'whatsapp', pin })
      }
    );
    const data = await r.json();
    console.log('Resultado do phone-register:', JSON.stringify(data));
    res.json({ status: r.status, pinUsado: pin, data });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── ROTA: VER O VÍNCULO ENTRE A CONTA WHATSAPP E O APP (debug)
// Se "data" voltar vazio, a conta não está inscrita em nenhum app e a Meta
// não tem para onde entregar as mensagens recebidas.
app.get('/webhook-status', async (req, res) => {
  try {
    const r = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/subscribed_apps`,
      { headers: { 'Authorization': `Bearer ${WA_TOKEN}` } }
    );
    const data = await r.json();
    res.json({ status: r.status, wabaId: WABA_ID, data });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── ROTA: CRIAR O VÍNCULO (rodar uma vez)
// Inscreve o app nesta WhatsApp Business Account. Retorno esperado:
// {"success":true}. Depois disso as mensagens começam a chegar no webhook.
app.get('/webhook-subscribe', async (req, res) => {
  try {
    const r = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/subscribed_apps`,
      { method: 'POST', headers: { 'Authorization': `Bearer ${WA_TOKEN}` } }
    );
    const data = await r.json();
    console.log('Resultado do webhook-subscribe:', JSON.stringify(data));
    res.json({ status: r.status, wabaId: WABA_ID, data });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── FUNÇÃO: ENVIAR EMAIL DE LEAD via Resend
async function enviarEmailLead(lead, numero = null) {
  if (!validarLead(lead)) {
    console.log('EMAIL BLOQUEADO: lead sem contato suficiente:', lead.nome, lead.empresa);
    return;
  }

  const html = `
    <h2 style="color:#47166B">Novo Lead Qualificado — Ginger Agente</h2>
    ${numero ? `<p><b>Número WhatsApp:</b> ${numero}</p>` : ''}
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
      <tr><td><b>Nome</b></td><td>${lead.nome || '-'}</td></tr>
      <tr><td><b>Cargo</b></td><td>${lead.cargo || '-'}</td></tr>
      <tr><td><b>Empresa</b></td><td>${lead.empresa || '-'}</td></tr>
      <tr><td><b>CNPJ</b></td><td>${lead.cnpj || '-'}</td></tr>
      <tr><td><b>Email</b></td><td>${lead.email || '-'}</td></tr>
      <tr><td><b>Telefone</b></td><td>${lead.telefone || '-'}</td></tr>
      <tr><td><b>Funcionários</b></td><td>${lead.funcionarios || '-'}</td></tr>
      <tr><td><b>Segmento</b></td><td>${lead.segmento || '-'}</td></tr>
      <tr><td><b>Fornecedor Atual</b></td><td>${lead.fornecedor_atual || '-'}</td></tr>
      <tr><td><b>Volume Mensal</b></td><td>${lead.volume_mensal || '-'}</td></tr>
      <tr><td><b>Projeto</b></td><td>${lead.projeto || '-'}</td></tr>
      <tr><td><b>Classificação</b></td><td>${lead.classificacao || '-'}</td></tr>
      <tr><td><b>Motivo</b></td><td>${lead.motivo_classificacao || '-'}</td></tr>
    </table>
    <p style="color:#888;font-size:12px">Gerado automaticamente pelo Agente Ginger</p>
  `;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Ginger Agente <lead@ginger.ind.br>',
        to: process.env.EMAIL_COMERCIAL.split(','),
        subject: `Novo Lead ${lead.classificacao || 'BOM'}: ${lead.empresa || 'Sem empresa'} — Agente Ginger`,
        html
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Erro Resend:', data);
      throw new Error(data.message || 'Erro ao enviar');
    }
    console.log('Email enviado com sucesso via Resend:', data.id);
  } catch(error) {
    console.error('Erro detalhado ao enviar email:', error.message);
    throw error;
  }
}

// ── AUTO-PING: mantém servidor acordado (a cada 14 minutos)
setInterval(() => {
  fetch('https://ginger-backend-8ftm.onrender.com/')
    .then(() => console.log('Auto-ping: servidor mantido acordado'))
    .catch(() => console.log('Auto-ping: falhou'));
}, 14 * 60 * 1000);

// ── VERIFICAÇÃO AUTOMÁTICA DA PLANILHA
setInterval(() => {
  verificarNovosLeads();
}, INTERVALO_VERIFICACAO_MS);

// ── INICIAR SERVIDOR
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor Ginger rodando na porta ${PORT}`);
  console.log('Canal: WhatsApp Cloud API (Meta)');
  console.log('Phone Number ID:', WA_PHONE_ID || 'NÃO CONFIGURADO');
  console.log('Template de abordagem:', TEMPLATE_ABORDAGEM, TEMPLATE_IDIOMA);
  console.log('Planilha:', SPREADSHEET_ID);
  console.log('Redis Upstash: ' + (REDIS_URL ? 'CONFIGURADO' : 'NÃO CONFIGURADO'));
  console.log(`Delay de resposta: ${RESPOSTA_DELAY_MIN_MS / 1000}s a ${RESPOSTA_DELAY_MAX_MS / 1000}s`);
  console.log('Teste credenciais Meta: GET /cloud-test');
  console.log('Teste planilha (leitura): GET /sheet-test');
  console.log('Teste planilha (escrita): GET /sheet-write-test');
  console.log('Teste Redis: GET /redis-test');
  console.log('Teste Claude: GET /claude-test');
  console.log('Status do numero: GET /phone-status');
  console.log('Previa do backlog: GET /backlog-previa?dias=45');
  console.log('Ativar o numero: GET /phone-register');
  console.log('Ver vinculo do webhook: GET /webhook-status');
  console.log('Criar vinculo do webhook: GET /webhook-subscribe');

  if (!WA_TOKEN || !WA_PHONE_ID || !WA_VERIFY_TOKEN) {
    console.warn('⚠️ Faltam variáveis da Cloud API. Configure WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_VERIFY_TOKEN no Render.');
  }

  if (REDIS_URL) {
    const teste = await redis('PING');
    console.log('Redis PING:', teste === 'PONG' ? 'CONECTADO' : 'FALHOU');
  }
});
