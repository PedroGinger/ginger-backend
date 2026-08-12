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
// ══════════════════════════════════════════════════════════════
// ── INSTAGRAM DIRECT
// ══════════════════════════════════════════════════════════════
// Variaveis necessarias no Render:
//   INSTAGRAM_TOKEN    → token de acesso da conta profissional do Instagram
//   INSTAGRAM_USER_ID  → ID da conta profissional (o destinatario do POST)
//   META_VERIFY_TOKEN  → opcional. Se ausente, reusa WHATSAPP_VERIFY_TOKEN
//
// Nao precisa de App Review: a documentacao da Meta dispensa a revisao quando
// o app manda e recebe mensagens da propria conta ou pagina do desenvolvedor.
// Janela de resposta livre de 24h, igual ao WhatsApp. Fora dela existe a
// etiqueta de agente humano, que nao esta implementada aqui de proposito,
// porque ela e para atendimento humano, nao para robo.
const IG_TOKEN = process.env.INSTAGRAM_TOKEN;
const IG_USER_ID = process.env.INSTAGRAM_USER_ID;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN;
// ⚠️ HOST CORRETO, ERRO QUE JA CUSTOU UMA RODADA ⚠️
// Existem dois caminhos para a API do Instagram e eles NAO compartilham host:
//   "API setup with Instagram login"  → token do Instagram → graph.instagram.com
//   "API setup with Facebook login"   → token de Pagina    → graph.facebook.com
// A Ginger usa o primeiro. Mandar um token do Instagram para o graph.facebook.com
// devolve "Invalid OAuth access token - Cannot parse access token", codigo 190,
// que parece token invalido mas e endereco errado.
const IG_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;
// ══════════════════════════════════════════════════════════════
// ── FACEBOOK MESSENGER
// ══════════════════════════════════════════════════════════════
// Variaveis necessarias no Render:
//   FACEBOOK_PAGE_TOKEN → token de acesso da Pagina
//   FACEBOOK_PAGE_ID    → ID numerico da Pagina
//   META_VERIFY_TOKEN   → o mesmo do Instagram, ja configurado
//
// Ao contrario do Instagram, o Messenger fala com graph.facebook.com, porque
// o token e de Pagina e nao de conta do Instagram. Sao dois hosts diferentes
// no mesmo arquivo de proposito, e trocar um pelo outro devolve o erro 190.
//
// Token de Pagina gerado por usuario de sistema nao expira, entao aqui nao
// existe rotina de renovacao como no Instagram.
const FB_TOKEN = process.env.FACEBOOK_PAGE_TOKEN;
const FB_PAGE_ID = process.env.FACEBOOK_PAGE_ID;
const FB_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const FB_PREFIXO = 'fb:';
function chaveFacebook(psid) {
  return FB_PREFIXO + String(psid || '').replace(/\D/g, '');
}
// Prefixo da chave de conversa e do ID_CANAL. Mantem o identificador do
// Instagram longe de qualquer codigo que espere telefone.
const IG_PREFIXO = 'ig:';
function chaveInstagram(igsid) {
  return IG_PREFIXO + String(igsid || '').replace(/\D/g, '');
}
// ══════════════════════════════════════════════════════════════
// ── TOKEN DO INSTAGRAM: RENOVAÇÃO AUTOMÁTICA
// ══════════════════════════════════════════════════════════════
// O token de longa duracao do Instagram vale cerca de 60 dias. Quando vence,
// o bot para de responder EM SILENCIO: nao ha erro visivel, nao ha aviso, as
// mensagens simplesmente deixam de ser respondidas. Dois meses depois de ligar
// o canal, isso vira um misterio de meio dia.
//
// A renovacao devolve um token NOVO, e o codigo nao consegue reescrever a
// variavel de ambiente do Render. Entao o token vigente vive no Redis, e a
// variavel de ambiente serve so como semente inicial.
//
// Regra da Meta: so da para renovar um token com mais de 24h de vida. Por isso
// o boot NAO renova, apenas registra desde quando conhece o token. A rotina
// diaria renova quando passa de 7 dias, o que mantem folga enorme ate os 60.
let igTokenCache = null;
let igTokenOrigem = 'ambiente';
let igTokenVistoEm = null;
async function tokenInstagram() {
  if (igTokenCache) return igTokenCache;
  const salvo = await redis('GET', 'ig:token');
  if (salvo) {
    igTokenCache = salvo;
    igTokenOrigem = 'redis';
    const ts = await redis('GET', 'ig:token_visto_em');
    igTokenVistoEm = ts ? parseInt(ts) : null;
    return igTokenCache;
  }
  igTokenCache = IG_TOKEN || null;
  igTokenOrigem = 'ambiente';
  return igTokenCache;
}
async function guardarTokenInstagram(tok, origem) {
  igTokenCache = tok;
  igTokenOrigem = origem;
  igTokenVistoEm = Date.now();
  await redis('SET', 'ig:token', tok);
  await redis('SET', 'ig:token_visto_em', String(igTokenVistoEm));
}
function idadeTokenEmDias() {
  if (!igTokenVistoEm) return null;
  return Math.floor((Date.now() - igTokenVistoEm) / 86400000);
}
async function renovarTokenInstagram(motivo) {
  const atual = await tokenInstagram();
  if (!atual) return { ok: false, erro: 'nenhum token configurado' };
  try {
    const r = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(atual)}`
    );
    const d = await r.json();
    if (!r.ok || d.error || !d.access_token) {
      console.error(`⚠️ FALHA ao renovar o token do Instagram (${motivo}):`,
        JSON.stringify(d).substring(0, 300));
      return { ok: false, data: d };
    }
    await guardarTokenInstagram(d.access_token, 'redis');
    const dias = Math.round((d.expires_in || 0) / 86400);
    console.log(`Token do Instagram renovado (${motivo}). Nova validade: cerca de ${dias} dias.`);
    return { ok: true, validadeDias: dias };
  } catch(e) {
    console.error(`⚠️ Erro de rede ao renovar o token do Instagram (${motivo}):`, e.message);
    return { ok: false, erro: e.message };
  }
}
// Primeira vez que o processo ve um token: registra a data, sem renovar.
async function semearTokenInstagram() {
  if (!IG_TOKEN) return;
  const salvo = await redis('GET', 'ig:token');
  if (salvo) {
    await tokenInstagram();
    console.log(`Token do Instagram: vindo do Redis, conhecido ha ${idadeTokenEmDias()} dia(s).`);
    return;
  }
  await guardarTokenInstagram(IG_TOKEN, 'ambiente');
  console.log('Token do Instagram: semeado a partir da variavel de ambiente. Primeira renovacao em 7 dias.');
}
// Rotina diaria de renovacao.
async function rotinaTokenInstagram() {
  if (!IG_TOKEN && !igTokenCache) return;
  await tokenInstagram();
  const dias = idadeTokenEmDias();
  if (dias === null) { await semearTokenInstagram(); return; }
  if (dias >= 7) {
    await renovarTokenInstagram(`rotina diaria, token com ${dias} dias`);
  } else {
    console.log(`Token do Instagram com ${dias} dia(s), ainda nao precisa renovar.`);
  }
}
// Chave usada para agrupar conversas na inbox e no painel. Numero de WhatsApp
// vira chave canonica; Instagram e chat do site ja chegam com prefixo proprio
// e NAO podem passar por chaveNumero, que arrancaria o prefixo.
function chaveConversa(bruto) {
  const s = String(bruto || '').trim();
  if (!s) return '';
  if (s.startsWith('site-') || s.startsWith(IG_PREFIXO) || s.startsWith(FB_PREFIXO)) return s;
  return chaveNumero(s) || s;
}
function canalDaChave(chave) {
  const s = String(chave || '');
  if (s.startsWith(IG_PREFIXO)) return 'Instagram';
  if (s.startsWith(FB_PREFIXO)) return 'Facebook';
  if (s.startsWith('site-')) return 'Chat do site';
  return 'WhatsApp';
}
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
// ══════════════════════════════════════════════════════════════
// ── ESTRUTURA DE COLUNAS DA PLANILHA DE LEADS
// ══════════════════════════════════════════════════════════════
// Mudanca da sessao 22. Antes a coluna I (TRATATIVA) guardava dois eixos
// diferentes no mesmo campo: o estado operacional ("abordado pelo agente")
// e o resultado da qualificacao ("BOM"). Como um sobrescrevia o outro, era
// impossivel medir quantos abordados viraram BOM. Agora sao campos separados:
//
//   A DATA          B NOME       C EMAIL      D TELEFONE
//   E EMPRESA       F CIDADE     G FATURAMENTO  H CNPJ
//   I STATUS        <- estado operacional, escrito pelo bot
//   J ORIGEM        <- bot-planilha ou bot-site, escrito pelo bot
//   K QUALIFICACAO  <- BOM, POTENCIAL_FUTURO, RUIM, NAO_LEAD, escrito pelo bot
//   L MOTIVO        <- justificativa em uma linha, escrito pelo bot
//   M PROJETO       <- numero do projeto no Otimizah, preenchido pelo comercial
//   N RESPONSAVEL   <- Juliana ou Jennifer, preenchido pelo comercial
//   O ID_CANAL      <- identificador do contato no canal, escrito pelo bot
//
// A coluna M e a unica realmente obrigatoria para humano. Sem ela a planilha
// de leads e a base de projetos ficam desconectadas e nao existe como medir
// retorno de abertura de projetos.
//
// A coluna O existe porque nem todo canal tem telefone. No Instagram a Meta
// entrega um identificador proprio da conta (IGSID), nao um numero. Sem um
// lugar para guardar esse ID, o lead de Instagram nunca encontra a propria
// linha e fica invisivel em toda metrica. Para WhatsApp ela guarda a chave
// canonica do numero, o que torna a busca independente do nono digito.
const CABECALHO_PADRAO = [
  'DATA', 'NOME', 'EMAIL', 'TELEFONE', 'EMPRESA', 'CIDADE', 'FATURAMENTO',
  'CNPJ', 'STATUS', 'ORIGEM', 'QUALIFICACAO', 'MOTIVO', 'PROJETO', 'RESPONSAVEL',
  'ID_CANAL'
];
const COL_ID_CANAL = 14; // indice zero-based da coluna O
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
// Mesmas funcoes, com a chave JA canonica. O Instagram usa estas.
async function getConversaChave(chave) {
  const data = await redis('GET', `conversa:${chave}`);
  if (!data) return null;
  try { return JSON.parse(data); } catch (e) { return null; }
}
async function saveConversaChave(chave, messages) {
  await redis('SET', `conversa:${chave}`, JSON.stringify(messages), 'EX', 86400);
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
// Versoes que recebem a chave JA canonica. Necessarias porque a chave do
// Instagram ("ig:178...") nao e telefone: passar ela por chaveNumero
// arrancaria o prefixo e inventaria um numero brasileiro inexistente.
async function getLinhaCache(chave) {
  const r = await redis('HGET', 'leads_planilha', chave);
  return r ? parseInt(r) : null;
}
async function setLinhaCache(chave, rowIndex) {
  await redis('HSET', 'leads_planilha', chave, String(rowIndex));
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
// Nota da sessao 22: o esqueleto de filtro por CNAE foi REMOVIDO. Ele estava
// inativo desde a sessao 19 esperando uma lista do juridico, e o Pedro decidiu
// que essa lista nao vai existir. Quem faz esse trabalho agora e o criterio 4
// da regua (segmento atendido), avaliado pelo agente na conversa.
// ══════════════════════════════════════════════════════════════
// ── PRÉ-FILTRO DE ABORDAGEM: CNPJ JÁ DECLARADO INEXISTENTE
// ══════════════════════════════════════════════════════════════
// Varias linhas da planilha trazem no campo CNPJ a propria negacao escrita
// pelo lead no formulario: "Nao tenho", "Nao", "0". Abordar essas pessoas
// gasta template de categoria Marketing, que e pago, para iniciar uma conversa
// que a REGRA DE ENTRADA vai encerrar na primeira resposta.
// Campo vazio NAO entra nesse filtro, porque a maioria das linhas boas tambem
// esta vazia. So filtra negacao explicita.
function cnpjDeclaradoInexistente(cnpj) {
  const t = String(cnpj || '').trim().toLowerCase();
  if (!t) return false;
  if (t === '0' || t === '00' || t === '-') return true;
  const digitos = t.replace(/\D/g, '');
  if (digitos.length >= 11) return false;
  const negacoes = [
    'nao tenho', 'não tenho', 'nao tem', 'não tem', 'n tenho', 'ntenho',
    'sem cnpj', 'nao possuo', 'não possuo', 'nao possui', 'não possui',
    'nenhum', 'pessoa fisica', 'pessoa física', 'sou cpf', 'apenas cpf',
    'so cpf', 'só cpf', 'somente cpf', 'ainda nao', 'ainda não', 'nao', 'não'
  ];
  return negacoes.some(n => t.includes(n));
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
Atenção interna: "ICP" nesta empresa significa a faixa acima de R$30k. NÃO use a palavra ICP como sinônimo de segmento atendido. Para segmento, use sempre a expressão "segmento atendido" e consulte a lista abaixo.
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
⚠️ REGRA ZERO — DIREÇÃO DA RELAÇÃO. AVALIE ANTES DE QUALQUER OUTRA COISA ⚠️
Antes de pensar em classificar, entenda o que o contato quer:
(a) COMPRAR fragrância ou matéria-prima da Ginger
(b) VENDER, oferecer ou cobrar algo DA Ginger
(c) Resolver assunto interno, administrativo, financeiro ou de pós-venda
Somente o caso (a) é lead. Os casos (b) e (c) recebem a classificação "NAO_LEAD".
Sinais de NAO_LEAD, qualquer um basta:
- Oferece produtos, serviços, insumos, logística, frete, transporte, armazenagem, importação, software, consultoria, crédito, seguro, recrutamento, publicidade ou representação comercial
- Pede para falar com um funcionário específico da Ginger, citando o nome da pessoa
- Diz que foi encaminhado pela recepção, secretaria, telefonista, portaria ou por outro setor da Ginger
- Trata de nota fiscal, pagamento, cobrança, proposta de fornecimento ou entrega de mercadoria destinada à Ginger
- É candidato a vaga de emprego
- É cliente ativo com problema de pedido, prazo, amostra, transporte ou pós-venda
- É imprensa, estudante, pesquisa acadêmica ou concorrente
COMO AGIR COM NAO_LEAD: seja cordial e breve. Não faça perguntas de briefing, não pergunte se tem CNPJ, não pergunte volume, não colete a ficha, não ofereça as revendas. Diga que vai direcionar internamente e oriente a escrever para contato@ginger.ind.br. Gere o bloco de dados com classificacao "NAO_LEAD" e o motivo em uma linha, mesmo que não tenha e-mail nem telefone.
Modelo: "Entendi! Esse assunto não é comigo, mas escrevendo para contato@ginger.ind.br a área responsável te retorna. Obrigado pelo contato!"
ATENÇÃO: um fornecedor querendo vender para a Ginger NÃO é lead, mesmo que tenha CNPJ, mesmo que seja empresa grande, mesmo que o assunto envolva fragrância. A pergunta é sempre: essa pessoa quer COMPRAR da Ginger? Se a resposta for não, é NAO_LEAD.
⚠️ REGRA DE ENTRADA — CNPJ É PRÉ-REQUISITO ⚠️
Aplique esta regra somente depois de concluir que o contato quer comprar, conforme a REGRA ZERO.
A Ginger é uma empresa B2B e vende exclusivamente para pessoa jurídica. Não existe venda para CPF, em nenhuma hipótese, independente do volume, do valor ou de quem seja o contato.
Por isso, saber se o contato tem CNPJ é a informação mais importante de toda a conversa, e deve ser esclarecida LOGO NO INÍCIO, na sua primeira ou segunda resposta. Não deixe para depois. Perguntar cedo poupa o tempo do contato e evita criar expectativa que não pode ser atendida.
Pergunte de forma curta e natural, nunca como interrogatório ou formulário:
"Legal, [Nome]! Só pra eu te direcionar do jeito certo, vocês já têm CNPJ?"
"Boa. Antes de eu seguir, uma pergunta rápida: a compra seria pelo CNPJ da empresa?"
Se o contato estiver no meio de uma explicação, deixe ele terminar e pergunte na sequência. Nunca corte a fala dele para perguntar isso.
SE O CONTATO TEM CNPJ:
Siga a conversa normalmente, com o briefing e a coleta progressiva descritos adiante.
SE O CONTATO NÃO TEM CNPJ:
Encerre de forma gentil e imediata. Não faça mais nenhuma pergunta de briefing, não pergunte volume, não pergunte projeto, não peça e-mail nem telefone. Explique com clareza e sem rodeio que a Ginger vende apenas para empresas, e direcione para as revendas parceiras, que atendem pessoa física e trabalham com volumes menores.
Modelo:
"Entendi, [Nome]. A Ginger trabalha só com venda para empresas, com CNPJ. Mas você consegue comprar as nossas fragrâncias através das revendas parceiras, que atendem pessoa física e vendem em volumes menores. [citar até três revendas adequadas ao caso]. Qualquer dúvida, é só chamar!"
Classifique como POTENCIAL_FUTURO com o motivo "Sem CNPJ, direcionado para revendas".
SE O CONTATO NÃO SOUBER, ESTIVER ABRINDO EMPRESA OU O CNPJ ESTIVER INATIVO:
Trate como sem CNPJ por enquanto, direcione para as revendas do mesmo jeito, e diga que quando o CNPJ estiver ativo a Ginger tem prazer em conversar sobre o projeto.
NUNCA insista depois de um não. NUNCA sugira que a pessoa use o CNPJ de um conhecido, de um parceiro ou de terceiros. NUNCA dê a entender que existe exceção, jeitinho ou caso especial. A regra vale sempre.
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
Colete essas informações aos poucos, conforme a conversa avança. Nunca pergunte tudo de uma vez. Peça nome e empresa cedo, e confirme a existência de CNPJ logo no início, conforme a REGRA DE ENTRADA. Depois disso, priorize entender a dor antes de pedir o resto dos dados cadastrais, e deixe o número completo do CNPJ, e-mail e telefone para quando o interesse estiver claro.
Atenção: confirmar SE existe CNPJ é diferente de pedir o NÚMERO do CNPJ. A confirmação vem logo no início e é rápida. O número completo você pede mais adiante, junto com os outros dados cadastrais.
⚠️ REGRA CRÍTICA DE CONTATO — INEGOCIÁVEL ⚠️
Esta é a regra mais importante de todo o sistema. Sem exceção.
NUNCA inclua o bloco %%%LEAD_DATA%%% com classificacao "BOM" sem ter coletado TODOS os três itens abaixo:
1. Nome
2. Empresa
3. Pelo menos um canal de contato direto: email OU telefone/WhatsApp
NUNCA inclua o bloco %%%LEAD_DATA%%% com classificacao BOM, POTENCIAL_FUTURO ou RUIM se os campos "email" E "telefone" estiverem ambos vazios. O comercial precisa de pelo menos um canal para dar continuidade. Sem contato = sem envio do bloco.
ÚNICA EXCEÇÃO: a classificação NAO_LEAD pode ser gerada sem contato nenhum, porque nesse caso não existe passagem para o comercial e o registro serve só para a métrica.
Se o lead demonstrou interesse mas ainda não informou contato, PARE TUDO e peça o contato antes de gerar o bloco. Não importa se a conversa está acabando, não importa se o lead parece apressado. Sem contato, o bloco não pode ser gerado.
Como pedir naturalmente:
"Perfeito, [Nome]. Para eu acionar nossa especialista e ela dar continuidade com você, me passa seu email ou WhatsApp de preferência?"
"Antes de encaminhar, qual o melhor canal para nossa equipe te contatar? Email ou WhatsApp?"
CHECKLIST ANTES DE GERAR O BLOCO (faça mentalmente toda vez):
✅ Já apliquei a REGRA ZERO e confirmei que essa pessoa quer COMPRAR da Ginger? Se não, classificação é NAO_LEAD.
✅ Tem nome? Se não, pergunte.
✅ Tem empresa? Se não, pergunte.
✅ Tem email OU telefone? Se não, PERGUNTE ANTES DE QUALQUER COISA.
✅ Só depois de confirmar os 4, gere o bloco.
CLASSIFICAÇÃO DO LEAD — OBRIGATÓRIO
Primeiro aplique a REGRA ZERO. Se for NAO_LEAD, pare aqui e não avalie mais nada.
Se o contato quer comprar, classifique entre BOM, POTENCIAL_FUTURO e RUIM.
LEAD BOM — os QUATRO critérios abaixo precisam estar satisfeitos AO MESMO TEMPO, além de nome, empresa e contato. Falhou um, não é BOM. Os critérios são cumulativos, não são alternativas.
1. CNPJ: tem CNPJ, empresa formal. CPF não serve, nem que o número tenha sido informado.
2. PROJETO: demonstrou interesse real em ABRIR UM PROJETO de fragrância. Interesse genérico em "contato comercial", "conhecer a empresa", "receber informações", "fazer uma parceria" ou "trocar uma ideia" NÃO satisfaz este critério.
3. VOLUME: informou o volume E ele é igual ou superior a R$5 mil por mês OU 3 kg por fragrância por pedido.
4. SEGMENTO: a aplicação está entre os segmentos atendidos, ou seja cosméticos, HPPC, saneantes, home care, pet care, perfumaria fina ou aromatização de ambiente.
⚠️ REGRA DO CAMPO VAZIO ⚠️
Se você não obteve a informação, o critério FALHOU. Não presuma pelo porte da empresa, não deduza pelo nome do segmento, não conceda benefício da dúvida, não preencha com estimativa própria. Se o volume não foi informado, o critério 3 falhou. Ou você pergunta e obtém a resposta, ou classifica abaixo de BOM. Vale igualmente para projeto e segmento.
⚠️ A REGRA DE EXPERTISE NÃO É REGRA DE CLASSIFICAÇÃO ⚠️
A orientação de nunca dizer que algo "não é nossa expertise" governa o que você DIZ ao contato. Ela não governa como você CLASSIFICA. Um contato de segmento fora da lista não deve ouvir que a Ginger não atende, e ao mesmo tempo não pode ser classificado como BOM. As duas coisas convivem sem conflito.
LEAD POTENCIAL FUTURO — classifique como "POTENCIAL_FUTURO" quando o contato quer comprar mas:
- Não tem CNPJ mas tem interesse real, ou
- Tem CNPJ mas volume abaixo de R$5k/mês E abaixo de 3kg por fragrância, ou
- Tem CNPJ e projeto real mas não informou volume e não quis informar, ou
- Tem projeto real mas ainda não está pronto para compra direta, ou
- Está fora dos segmentos atendidos
Nesses casos, direcionar educadamente para as revendas parceiras da Ginger.
IMPORTANTE: mesmo para POTENCIAL_FUTURO, só gere o bloco se tiver pelo menos um contato (email ou telefone).
LEAD RUIM — classifique como "RUIM" apenas quando:
- Não tem empresa, não tem projeto, não tem interesse real
- É apenas curioso, estudante, ou testando o chat
- Parou de responder sem demonstrar interesse
- Não tem nenhum potencial de negócio
Para RUIM, o bloco é opcional. Se não tiver contato, não gere o bloco.
NAO_LEAD — conforme a REGRA ZERO. Não é comprador. Fornecedor, candidato, cobrança, assunto interno, imprensa, concorrente.
MOTIVOS PADRÃO:
BOM: "Projeto concreto identificado", "Volume adequado e segmento atendido", "Interesse real e CNPJ confirmado"
POTENCIAL_FUTURO: "Volume abaixo do mínimo, direcionado para revendas", "Sem CNPJ, direcionado para revendas", "Volume não informado", "Segmento fora dos atendidos"
RUIM: "Apenas curioso, sem projeto", "Sem interesse real", "Parou de responder"
NAO_LEAD: "Fornecedor oferecendo serviço", "Procurava funcionário específico", "Assunto administrativo", "Candidato a vaga", "Cliente com questão de pós-venda"
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
Quando o lead demonstrar pressa, querer fechar rápido, já tiver uma fragrância ou quantidade em mente, ou simplesmente não quiser conversar muito, o agente DEVE ser direto e curto. Respostas de no máximo 2 a 3 linhas. Sem explicações longas, sem perguntas abertas, sem apresentar o método ou a empresa. Apenas coletar as informações cruciais para o comercial: Nome, Empresa, CNPJ, Email, Telefone e quantidade desejada. Assim que tiver esses 6 dados, avaliar os quatro critérios e classificar. Não insistir em mais informações.
Atenção: no MODO RÁPIDO a quantidade desejada é obrigatória, porque é ela que satisfaz o critério 3. Se o lead não informar quantidade nem volume, não classifique como BOM, classifique como POTENCIAL_FUTURO com o motivo "Volume não informado".
MODO COMPLETO (lead tranquilo e receptivo):
Quando o lead estiver respondendo com calma e detalhando seu projeto, seguir com o briefing completo normalmente, coletando todos os 11 campos e entendendo a dor antes de encerrar. Mesmo neste modo, mantenha cada mensagem curta (2 a 3 frases) e faça uma pergunta de cada vez. Briefing completo se constrói ao longo de várias mensagens curtas, nunca em um texto longo só.
COMO IDENTIFICAR O MODO:
- Lead manda mensagens curtas, diretas, pede para "fechar logo" ou "só preciso de X" = MODO RÁPIDO
- Lead faz perguntas, descreve o projeto, conta sobre a empresa = MODO COMPLETO
- Na dúvida, comece com resposta curta e veja como o lead reage
NUNCA force respostas longas quando o lead está com pressa. Ler o ritmo da conversa e se adaptar é obrigatório.
COMPORTAMENTO COM LEAD BOM
Existem dois caminhos para chegar a BOM, e em ambos os quatro critérios continuam obrigatórios.
CAMINHO RÁPIDO (lead com pressa): Quando tiver Nome, Empresa, CNPJ, Email, Telefone e quantidade desejada, avalie os quatro critérios e classifique. Não precisa de cargo, número de funcionários, fornecedor atual nem briefing detalhado. O comercial resolve o resto.
CAMINHO COMPLETO (lead tranquilo): Classifique como BOM após coletar a ficha mais completa possível e confirmar os quatro critérios.
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
Canal para assuntos que não são de venda: contato@ginger.ind.br
⚠️ QUANDO GERAR O BLOCO DE DADOS — REGRA CRÍTICA ⚠️
NÃO gere o bloco %%%LEAD_DATA%%% apenas porque tem nome, empresa e contato. O bloco só deve ser gerado quando a conversa chegou a um ponto de CONCLUSÃO, ou seja:
- Para BOM: você já coletou informações suficientes, já entendeu o projeto, já confirmou os quatro critérios, já pediu CNPJ e contato, e está pronto para encerrar e acionar o comercial.
- Para POTENCIAL_FUTURO: você já entendeu que o volume é baixo, não foi informado, não tem CNPJ ou o segmento está fora, e vai direcionar para revendas.
- Para RUIM: você já confirmou que não há interesse real.
- Para NAO_LEAD: você já identificou que a pessoa não quer comprar da Ginger. Aqui o bloco pode ser gerado de imediato, sem coletar nada.
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
  "motivo_classificacao": "",
  "criterio_cnpj": "",
  "criterio_projeto": "",
  "criterio_volume": "",
  "criterio_segmento": ""
}
%%%END_LEAD_DATA%%%
Atualize esse bloco a cada resposta com os dados mais recentes. Deixe em branco os que ainda não foram informados. Sempre preencha classificacao e motivo_classificacao assim que tiver informação suficiente.
Os quatro campos criterio_ recebem exatamente "OK" ou "FALHOU", e são obrigatórios sempre que a classificacao for BOM, POTENCIAL_FUTURO ou RUIM. Eles são a apuração honesta dos quatro critérios de BOM, e servem de conferência para a equipe. Se você marcar classificacao "BOM", os quatro precisam estar "OK". Se algum estiver "FALHOU", a classificacao não pode ser BOM. Para NAO_LEAD, deixe os quatro em branco.
Nunca marque um critério como "OK" quando a informação não foi obtida. Campo sem informação é "FALHOU".
⚠️ VALIDAÇÃO FINAL ANTES DE GERAR O BLOCO (obrigatório toda vez):
Antes de escrever %%%LEAD_DATA%%%, verifique:
1. Apliquei a REGRA ZERO? Se a pessoa não quer comprar da Ginger, a classificacao é NAO_LEAD e o resto não se aplica.
2. O campo "email" OU "telefone" está preenchido? Se AMBOS estão vazios e a classificacao não é NAO_LEAD, NÃO gere o bloco. Peça o contato primeiro.
3. O campo "nome" está preenchido? Se não, e a classificacao não é NAO_LEAD, NÃO gere o bloco.
4. O campo "empresa" está preenchido? Se não, e a classificacao não é NAO_LEAD, NÃO gere o bloco.
5. Se marquei "BOM", os quatro campos criterio_ estão todos "OK"? Se algum está "FALHOU", corrija a classificacao para POTENCIAL_FUTURO.
Se qualquer uma dessas validações falhar, continue a conversa e colete a informação faltante. NUNCA gere o bloco incompleto.`;
// ══════════════════════════════════════════════════════════════
// ── VALIDAÇÃO E APURAÇÃO
// ══════════════════════════════════════════════════════════════
function classificacaoNormalizada(lead) {
  return String(lead && lead.classificacao || '').trim().toUpperCase();
}
function isNaoLead(lead) {
  return classificacaoNormalizada(lead) === 'NAO_LEAD';
}
function validarLead(parsed) {
  if (!parsed.nome || !parsed.nome.trim()) return false;
  if (!parsed.empresa || !parsed.empresa.trim()) return false;
  const temEmail = parsed.email && parsed.email.trim() && parsed.email.trim() !== '-';
  const temTelefone = parsed.telefone && parsed.telefone.trim() && parsed.telefone.trim() !== '-';
  if (!temEmail && !temTelefone) return false;
  return true;
}
// Conta quantos dos quatro critérios de BOM o agente marcou como OK.
// Serve para estampar o placar no e-mail. Um "BOM 1/4" fica visível no assunto
// em vez de escondido dentro de uma frase de motivo bem escrita.
function placarCriterios(lead) {
  const campos = ['criterio_cnpj', 'criterio_projeto', 'criterio_volume', 'criterio_segmento'];
  let ok = 0, informados = 0;
  const detalhe = {};
  for (const c of campos) {
    const v = String(lead[c] || '').trim().toUpperCase();
    if (v) informados++;
    if (v === 'OK') ok++;
    detalhe[c] = v || 'NAO APURADO';
  }
  return { ok, informados, detalhe };
}
// Rede de segurança no código. Se o agente marcar BOM mas algum critério
// estiver FALHOU, o backend rebaixa para POTENCIAL_FUTURO antes de avisar o
// comercial. O prompt já pede isso, mas prompt é instrução e código é garantia.
function corrigirClassificacaoSeInconsistente(lead) {
  const classif = classificacaoNormalizada(lead);
  if (classif !== 'BOM') return { corrigido: false, classificacao: classif };
  const placar = placarCriterios(lead);
  if (placar.informados === 4 && placar.ok < 4) {
    lead.classificacao = 'POTENCIAL_FUTURO';
    const antes = lead.motivo_classificacao || '';
    lead.motivo_classificacao =
      `Rebaixado automaticamente, ${placar.ok} de 4 critérios atendidos. Motivo original: ${antes}`;
    console.log(`Classificação rebaixada de BOM para POTENCIAL_FUTURO (${placar.ok}/4):`, lead.nome, lead.empresa);
    return { corrigido: true, classificacao: 'POTENCIAL_FUTURO' };
  }
  return { corrigido: false, classificacao: 'BOM' };
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
// Extrai mes e ano de uma data no formato DD/MM/AAAA HH:MM:SS
function mesAnoDaData(dataStr) {
  try {
    const p = String(dataStr || '').split(' ')[0].split('/');
    if (p.length < 3) return null;
    return { mes: parseInt(p[1]), ano: parseInt(p[2]) };
  } catch(e) {
    return null;
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
      range: `${SHEET_NAME}!A:O`
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
// ── COLUNA I: STATUS OPERACIONAL
// Era chamada de "tratativa" e acumulava status e qualificação no mesmo campo.
// Agora guarda só o estado operacional. A dedução de "já tratado" usada pela
// abordagem ativa e pela prévia do backlog continua lendo esta coluna, então
// o comportamento de não reabordar segue idêntico.
async function atualizarStatus(rowIndex, valor) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!I${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[valor]] }
    });
    console.log(`Planilha atualizada (status): linha ${rowIndex} = "${valor}"`);
  } catch(e) {
    console.error('Erro ao atualizar status:', e.message);
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
// ── COLUNAS K e L: QUALIFICACAO e MOTIVO
// Eixo independente do status. É isso que torna o funil auditável: um lead
// pode estar ABORDADO na coluna I e BOM na coluna K ao mesmo tempo.
async function atualizarQualificacao(rowIndex, classificacao, motivo) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!K${rowIndex}:L${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[classificacao || '', (motivo || '').substring(0, 500)]] }
    });
    console.log(`Planilha atualizada (qualificação): linha ${rowIndex} = "${classificacao}"`);
  } catch(e) {
    console.error('Erro ao atualizar qualificação:', e.message);
  }
}
// ── COLUNA O: ID DO CONTATO NO CANAL
// Guarda a chave canonica do WhatsApp ou o "ig:<IGSID>" do Instagram, para
// que a linha continue localizavel mesmo se o Redis perder o mapeamento.
async function buscarLinhaPorIdCanal(idCanal) {
  if (!idCanal) return null;
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return null;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:O`
    });
    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][COL_ID_CANAL] || '').trim() === idCanal) return i + 1;
    }
    return null;
  } catch(e) {
    console.error('Erro ao buscar linha por ID de canal:', e.message);
    return null;
  }
}
// ══════════════════════════════════════════════════════════════
// ── CRIAR LINHA PARA CONTATO QUE NAO ESTA NA PLANILHA
// ══════════════════════════════════════════════════════════════
// Antes desta funcao, o bot so carimbava a planilha quando encontrava a linha
// do lead pelo telefone. Quem chamava o WhatsApp direto, sem nunca preencher
// o formulario, conversava, era qualificado, disparava e-mail para o comercial
// e NAO ENTRAVA em metrica nenhuma. No Instagram seria pior ainda, porque ali
// nao existe telefone e NENHUM contato acharia linha.
// Agora, quando nao ha linha, o bot cria uma.
async function criarLinhaLead(dados) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return null;
    const linha = [
      dados.data || agoraBrasil(),
      dados.nome || '', dados.email || '', dados.telefone || '',
      dados.empresa || '', dados.cidade || '', dados.faturamento || '', dados.cnpj || '',
      dados.status || 'em atendimento', dados.origem || '', '', '', '', '',
      dados.idCanal || ''
    ];
    const r = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:O`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [linha] }
    });
    // A API devolve o intervalo onde gravou, por exemplo "Página1!A48:O48".
    const faixa = r.data && r.data.updates && r.data.updates.updatedRange;
    const m = faixa && faixa.match(/![A-Z]+(\d+)/);
    const rowIndex = m ? parseInt(m[1]) : null;
    console.log(`Linha criada na planilha para ${dados.idCanal || dados.telefone}: linha ${rowIndex}`);
    return rowIndex;
  } catch(e) {
    console.error('Erro ao criar linha do lead:', e.message);
    return null;
  }
}
// Localiza a linha do contato e, se nao existir, cria. Devolve o indice.
// canal: 'whatsapp' ou 'instagram'. Usado tambem para decidir a origem.
async function garantirLinhaDoContato({ idCanal, telefone, nome, origem }) {
  let rowIndex = await getLinhaCache(idCanal);
  if (rowIndex) return rowIndex;
  if (telefone) {
    rowIndex = await buscarLinhaPorTelefone(telefone);
    if (rowIndex) {
      await setLinhaCache(idCanal, rowIndex);
      // Carimba o ID do canal na linha antiga, para nao depender do Redis.
      await atualizarIdCanal(rowIndex, idCanal);
      return rowIndex;
    }
  }
  rowIndex = await buscarLinhaPorIdCanal(idCanal);
  if (rowIndex) {
    await setLinhaCache(idCanal, rowIndex);
    return rowIndex;
  }
  // TRAVA CONTRA LINHA REPETIDA.
  // Quando alguem manda tres mensagens seguidas, a Meta entrega os tres
  // webhooks quase juntos. Sem trava, os tres passam pelas buscas acima antes
  // de qualquer um gravar, e a planilha ganha tres linhas identicas para o
  // mesmo contato. Foi o que aconteceu com a hildaestéticista no Instagram,
  // linhas 52, 53 e 54, todas 16:44:07 do mesmo dia.
  // Quem pega a trava cria a linha. Os outros esperam o cache aparecer.
  const trava = `linha_lock:${idCanal}`;
  const peguei = await redis('SET', trava, '1', 'NX', 'EX', 30);
  if (!peguei) {
    for (let tentativa = 0; tentativa < 20; tentativa++) {
      await delay(500);
      rowIndex = await getLinhaCache(idCanal);
      if (rowIndex) return rowIndex;
    }
    // A trava existe mas o cache nunca apareceu. Melhor tentar criar do que
    // devolver nada e perder o lead: linha repetida se conserta, lead perdido nao.
    console.log(`Trava de linha esgotou a espera para ${idCanal}, seguindo mesmo assim`);
  }
  try {
    rowIndex = await criarLinhaLead({
      nome: nome || '', telefone: telefone || '', origem, idCanal,
      status: 'em atendimento'
    });
    if (rowIndex) await setLinhaCache(idCanal, rowIndex);
  } finally {
    if (peguei) await redis('DEL', trava);
  }
  return rowIndex;
}
async function atualizarIdCanal(rowIndex, idCanal) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!O${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[idCanal]] }
    });
  } catch(e) {
    console.error('Erro ao gravar ID de canal:', e.message);
  }
}
// ══════════════════════════════════════════════════════════════
// ── ENVIO PELO INSTAGRAM DIRECT
// ══════════════════════════════════════════════════════════════
async function chamarInstagram(caminho, opts) {
  const tok = await tokenInstagram();
  if (!tok) return { ok: false, status: 0, data: { erro: 'sem token' } };
  const r = await fetch(`${IG_BASE}${caminho}`, {
    ...(opts || {}),
    headers: {
      'Authorization': `Bearer ${tok}`,
      'Content-Type': 'application/json',
      ...((opts && opts.headers) || {})
    }
  });
  const data = await r.json();
  return { ok: r.ok && !data.error, status: r.status, data };
}
async function enviarInstagram(igsid, texto) {
  if (!IG_USER_ID || !(await tokenInstagram())) {
    console.error('Instagram nao configurado: faltam INSTAGRAM_TOKEN e/ou INSTAGRAM_USER_ID');
    return { ok: false, erro: 'nao configurado' };
  }
  try {
    const r = await chamarInstagram(`/${IG_USER_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({ recipient: { id: igsid }, message: { text: texto } })
    });
    if (!r.ok) {
      const cod = r.data && r.data.error && r.data.error.code;
      // 10 e 551: fora da janela de 24h. Nao e defeito do bot, e regra da Meta.
      if (cod === 10 || cod === 551) {
        console.error(`Janela de 24h fechada no Instagram para ${igsid}. Só um humano pode reabrir.`);
      } else if (cod === 190) {
        console.error('⚠️ TOKEN DO INSTAGRAM INVÁLIDO OU VENCIDO. Renove em /instagram-status.');
      } else {
        console.error('Erro ao enviar no Instagram:', JSON.stringify(r.data).substring(0, 500));
      }
      return { ok: false, data: r.data };
    }
    return { ok: true, data: r.data };
  } catch(e) {
    console.error('Falha de rede ao enviar no Instagram:', e.message);
    return { ok: false, erro: e.message };
  }
}
// ══════════════════════════════════════════════════════════════
// ── ENVIO PELO FACEBOOK MESSENGER
// ══════════════════════════════════════════════════════════════
async function chamarFacebook(caminho, opts) {
  if (!FB_TOKEN) return { ok: false, status: 0, data: { erro: 'sem token de Pagina' } };
  const sep = caminho.indexOf('?') > -1 ? '&' : '?';
  const r = await fetch(`${FB_BASE}${caminho}${sep}access_token=${encodeURIComponent(FB_TOKEN)}`, {
    ...(opts || {}),
    headers: { 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) }
  });
  const data = await r.json();
  return { ok: r.ok && !data.error, status: r.status, data };
}
// Todas as chamadas usam /me em vez de /{ID_DA_PAGINA}. Com token de Pagina,
// /me JA resolve para a propria Pagina, entao o ID deixa de ser um ponto de
// falha. Pedir /{ID} exige que o ID esteja certo E que o token tenha permissao
// de ver aquele no especifico, e quando algo nao bate a Meta devolve o erro
// #100, "Object does not exist", que nao diz qual das duas coisas falhou.
async function enviarFacebook(psid, texto) {
  if (!FB_TOKEN) {
    console.error('Facebook nao configurado: falta FACEBOOK_PAGE_TOKEN');
    return { ok: false, erro: 'nao configurado' };
  }
  try {
    const r = await chamarFacebook(`/me/messages`, {
      method: 'POST',
      body: JSON.stringify({
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: { text: texto }
      })
    });
    if (!r.ok) {
      const cod = r.data && r.data.error && r.data.error.code;
      if (cod === 10 || cod === 551) {
        console.error(`Janela de 24h fechada no Messenger para ${psid}. Só um humano pode reabrir.`);
      } else if (cod === 190) {
        console.error('⚠️ TOKEN DA PÁGINA DO FACEBOOK INVÁLIDO OU VENCIDO.');
      } else {
        console.error('Erro ao enviar no Messenger:', JSON.stringify(r.data).substring(0, 500));
      }
      return { ok: false, data: r.data };
    }
    return { ok: true, data: r.data };
  } catch(e) {
    console.error('Falha de rede ao enviar no Messenger:', e.message);
    return { ok: false, erro: e.message };
  }
}
async function marcarVistoFacebook(psid) {
  if (!FB_TOKEN) return;
  try {
    await chamarFacebook(`/me/messages`, {
      method: 'POST', body: JSON.stringify({ recipient: { id: psid }, sender_action: 'mark_seen' })
    });
    await chamarFacebook(`/me/messages`, {
      method: 'POST', body: JSON.stringify({ recipient: { id: psid }, sender_action: 'typing_on' })
    });
  } catch(e) { /* indicador visual nunca derruba o atendimento */ }
}
async function perfilFacebook(psid) {
  try {
    const r = await chamarFacebook(`/${psid}?fields=first_name,last_name`);
    if (!r.ok) return null;
    const nome = [r.data.first_name, r.data.last_name].filter(Boolean).join(' ').trim();
    return { nome, usuario: '' };
  } catch(e) {
    return null;
  }
}
// Marca como visto e mostra "digitando", igual ao WhatsApp. Se a conta nao
// suportar, falha em silencio sem atrapalhar a resposta.
async function marcarVistoInstagram(igsid) {
  if (!IG_USER_ID) return;
  try {
    await chamarInstagram(`/${IG_USER_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({ recipient: { id: igsid }, sender_action: 'mark_seen' })
    });
    await chamarInstagram(`/${IG_USER_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({ recipient: { id: igsid }, sender_action: 'typing_on' })
    });
  } catch(e) { /* indicador visual nunca derruba o atendimento */ }
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
      range: `${SHEET_NAME}!A:O`
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
    let puladosSemCnpj = 0;
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
      const statusAtual = row[8] || '';
      if (statusAtual.trim()) continue;
      if (!isLeadRecente(data, janelaHoras)) continue;
      const numeroLimpo = limparTelefone(telefone);
      if (!numeroLimpo) {
        console.log(`Linha ${i + 1}: ${nome} sem telefone válido, marcando na planilha`);
        await atualizarStatus(i + 1, 'sem telefone válido');
        continue;
      }
      if (!nome.trim()) continue;
      // Pré-filtro: quem já declarou no formulário que não tem CNPJ não passa
      // pela REGRA DE ENTRADA de jeito nenhum. Abordar custa template pago e
      // abre uma conversa que encerra na primeira resposta.
      if (cnpjDeclaradoInexistente(cnpj)) {
        console.log(`Linha ${i + 1}: ${nome} declarou não ter CNPJ ("${cnpj}"). Não abordando.`);
        await atualizarStatus(i + 1, 'sem CNPJ declarado');
        await atualizarQualificacao(i + 1, 'POTENCIAL_FUTURO', 'Sem CNPJ declarado no formulário, não abordado');
        puladosSemCnpj++;
        continue;
      }
      const jaAbordado = await isNumeroAbordado(numeroLimpo);
      if (jaAbordado) {
        console.log(`Linha ${i + 1}: ${nome} já foi abordado antes, pulando`);
        await atualizarStatus(i + 1, 'duplicado, já abordado');
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
          await atualizarStatus(i + 1, 'número inválido ou sem WhatsApp');
          continue;
        }
        // Qualquer outro erro (token, limite, conta) e sistemico: para tudo.
        console.log(`⚠️ Erro sistêmico no envio para ${nome} (código ${codigo}). Interrompendo a rodada.`);
        break;
      }
      await atualizarStatus(i + 1, 'abordado pelo agente');
      await atualizarOrigem(i + 1, 'bot-planilha');
      // Carimba o ID do canal para a linha continuar localizavel sem o Redis.
      await atualizarIdCanal(i + 1, chaveNumero(numeroLimpo));
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
    console.log(`Verificação concluída: ${abordados} novos leads abordados, ${puladosSemCnpj} pulados por não ter CNPJ`);
    verificacaoRodando = false;
    return { status: 'concluído', abordados, puladosSemCnpj };
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
    phoneNumberId: WA_PHONE_ID ? 'configurado' : 'NÃO CONFIGURADO',
    versao: 'sessao 22, regua de qualificacao corrigida'
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
// ── TRATAMENTO DO BLOCO DE LEAD, COMPARTILHADO ENTRE OS CANAIS
// ══════════════════════════════════════════════════════════════
// WhatsApp e Instagram usam o MESMO prompt e a MESMA regua. Se cada webhook
// tivesse a sua copia desta logica, os dois canais divergiriam na primeira
// correcao feita so em um deles. Entao existe uma funcao so.
// Devolve o lead quando o comercial deve ser acionado, ou null.
async function completarDadosLead(rowIndex, parsed) {
  // Preenche nome, e-mail, empresa e CNPJ apenas onde a celula esta VAZIA.
  // O que o lead escreveu no formulario vale mais que o que o agente deduziu
  // na conversa, entao dado existente nunca e sobrescrito.
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${rowIndex}:O${rowIndex}`
    });
    const atual = (r.data.values && r.data.values[0]) || [];
    const mapa = [
      ['B', 1, parsed.nome], ['C', 2, parsed.email],
      ['E', 4, parsed.empresa], ['H', 7, parsed.cnpj]
    ];
    const data = [];
    for (const [col, idx, valor] of mapa) {
      const v = (valor || '').trim();
      if (v && v !== '-' && !((atual[idx] || '').trim())) {
        data.push({ range: `${SHEET_NAME}!${col}${rowIndex}`, values: [[v]] });
      }
    }
    if (!data.length) return;
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data }
    });
    console.log(`Linha ${rowIndex}: ${data.length} campo(s) cadastrais preenchidos pelo agente`);
  } catch(e) {
    console.error('Erro ao completar dados do lead:', e.message);
  }
}
async function tratarBlocoLead(parsed, ctx) {
  const rowIndex = await garantirLinhaDoContato({
    idCanal: ctx.idCanal,
    telefone: ctx.telefone,
    nome: parsed.nome || ctx.nomeFallback || '',
    origem: ctx.origem
  });
  if (isNaoLead(parsed)) {
    console.log('NAO_LEAD identificado, e-mail bloqueado:', parsed.nome, parsed.empresa, parsed.motivo_classificacao);
    if (rowIndex) {
      await atualizarStatus(rowIndex, 'encerrado, não é lead');
      await atualizarQualificacao(rowIndex, 'NAO_LEAD', parsed.motivo_classificacao);
      await atualizarOrigem(rowIndex, ctx.origem);
      await completarDadosLead(rowIndex, parsed);
    }
    return null;
  }
  if (!validarLead(parsed)) {
    console.log('Lead BLOQUEADO (dados incompletos):', JSON.stringify(parsed).substring(0, 300));
    return null;
  }
  const temClassificacao = parsed.classificacao && parsed.classificacao.trim() && parsed.classificacao.trim() !== '-';
  if (!temClassificacao) {
    console.log('Lead com dados mas SEM classificação, aguardando conclusão:', parsed.nome);
    return null;
  }
  corrigirClassificacaoSeInconsistente(parsed);
  const placar = placarCriterios(parsed);
  console.log('Lead VALIDADO:', parsed.nome, parsed.empresa,
    'Canal:', ctx.canal, 'Classificação:', parsed.classificacao, `Critérios: ${placar.ok}/4`);
  if (rowIndex) {
    await atualizarStatus(rowIndex, 'qualificado pelo agente');
    await atualizarQualificacao(rowIndex, classificacaoNormalizada(parsed), parsed.motivo_classificacao);
    await atualizarOrigem(rowIndex, ctx.origem);
    await completarDadosLead(rowIndex, parsed);
  }
  return parsed;
}
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
    // Mesma regra do Instagram: quem chama o WhatsApp direto, sem nunca ter
    // preenchido o formulario, ganha linha na planilha no primeiro contato.
    // Antes disso, essas conversas eram as "orfas" que o painel denunciava.
    await garantirLinhaDoContato({
      idCanal: chaveNumero(numero), telefone: numero, nome: '', origem: 'bot-site'
    });
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
        leadDetectado = await tratarBlocoLead(parsed, {
          idCanal: chaveNumero(numero), telefone: numero,
          origem: 'bot-site', canal: 'whatsapp'
        });
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
// Busca nome e @ do contato. Sem isso a inbox mostraria so o ID numerico e
// ninguem consegue auditar conversa de "17841400000000000".
async function perfilInstagram(igsid) {
  try {
    const r = await chamarInstagram(`/${igsid}?fields=name,username`);
    if (!r.ok) return null;
    return { nome: r.data.name || '', usuario: r.data.username || '' };
  } catch(e) {
    return null;
  }
}
// ══════════════════════════════════════════════════════════════
// ── ATENDIMENTO COMPARTILHADO: INSTAGRAM E MESSENGER
// ══════════════════════════════════════════════════════════════
// Os dois canais usam o mesmo formato de webhook da Meta e devem se comportar
// de forma identica. Uma funcao so, para que uma correcao feita hoje no
// Instagram nao deixe o Messenger para tras amanha. O que muda entre eles vem
// por parametro: como enviar, como marcar visto, como ler o perfil, e a nota
// de contexto que explica ao agente onde ele esta.
async function atenderCanalMeta(cfg) {
  const { psid, texto, chave, canal, origem, enviar, marcarVisto, perfil, notaDeContexto } = cfg;
  await marcarVisto(psid);
  await registrarConversa(chave, 'recebida', texto, origem);
  let historico = await getConversaChave(chave) || [];
  // A linha nasce no PRIMEIRO contato, nao na conclusao da qualificacao.
  // Se esperasse o bloco de lead, quem conversa e some antes do fim
  // continuaria invisivel, que e exatamente o buraco que fechamos.
  const perfilInicial = historico.length ? null : await perfil(psid);
  await garantirLinhaDoContato({
    idCanal: chave, telefone: '',
    nome: perfilInicial && (perfilInicial.nome || perfilInicial.usuario) || '',
    origem
  });
  if (!historico.length) {
    const nome = perfilInicial && (perfilInicial.nome || perfilInicial.usuario) || '';
    historico.push({
      role: 'user',
      content: `[CONTEXTO INTERNO — não mencionar ao contato]\n` + notaDeContexto +
        (nome ? `\nNome do perfil: ${nome}` : '') +
        (perfilInicial && perfilInicial.usuario ? `\nUsuário: @${perfilInicial.usuario}` : '')
    });
    historico.push({ role: 'assistant', content: 'Entendido.' });
  }
  historico.push({ role: 'user', content: texto });
  if (historico.length > 20) historico = historico.slice(-20);
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
  if (!data.content) console.log(`CLAUDE ERRO /${canal}:`, JSON.stringify(data).substring(0, 800));
  const raw = data.content?.[0]?.text || 'Não consegui processar. Pode repetir?';
  const regex = /%%%LEAD_DATA%%%([\s\S]*?)%%%END_LEAD_DATA%%%/;
  const match = raw.match(regex);
  let leadDetectado = null;
  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      leadDetectado = await tratarBlocoLead(parsed, {
        idCanal: chave,
        telefone: (parsed.telefone || '').trim() && parsed.telefone.trim() !== '-' ? parsed.telefone : '',
        nomeFallback: perfilInicial && (perfilInicial.nome || perfilInicial.usuario) || '',
        origem, canal
      });
    } catch(e) {
      console.log(`Erro ao parsear lead do ${canal}:`, e.message);
    }
  }
  const resposta = raw.replace(regex, '').trim();
  historico.push({ role: 'assistant', content: raw });
  await saveConversaChave(chave, historico);
  await delayHumanizado();
  const envio = await enviar(psid, resposta);
  console.log(`Envio no ${canal}:`, envio.ok ? 'ok' : 'FALHOU');
  if (envio.ok) await registrarConversa(chave, 'enviada', resposta, origem);
  if (leadDetectado) await enviarEmailLead(leadDetectado, `${psid} (${canal})`);
}
// Extrai o evento de mensagem util de um webhook no formato Messenger, ou
// devolve null quando o evento deve ser ignorado. Os motivos de ignorar sao
// os mesmos nos dois canais, entao a decisao mora num lugar so.
function eventoDeMensagem(body, idDaConta) {
  const ev = body?.entry?.[0]?.messaging?.[0];
  if (!ev || !ev.message) return null;
  // ECHO: a Meta devolve para o webhook TODA mensagem que a propria conta
  // envia. Sem esta trava o bot le a propria resposta como se fosse do
  // contato e conversa sozinho, em loop, gastando credito da Anthropic.
  if (ev.message.is_echo) return null;
  const psid = ev.sender && ev.sender.id;
  if (!psid) return null;
  if (idDaConta && String(psid) === String(idDaConta)) return null;
  return { psid, mid: ev.message.mid, texto: ev.message.text, mensagem: ev.message };
}
const NOTA_INSTAGRAM =
  'Esta conversa chegou pelo Instagram Direct da Ginger. O público do Instagram é ' +
  'majoritariamente consumidor final, então a REGRA DE ENTRADA sobre CNPJ tende a ser ' +
  'decisiva mais cedo que no WhatsApp. Aplique a REGRA ZERO e a REGRA DE ENTRADA ' +
  'normalmente, com o mesmo cuidado e a mesma cordialidade. Não peça telefone logo de ' +
  'cara, o contato já está falando com você por aqui.';
const NOTA_FACEBOOK =
  'Esta conversa chegou pelo Messenger da página da Ginger no Facebook. O público tende ' +
  'a ser consumidor final ou pequeno empreendedor, então a REGRA DE ENTRADA sobre CNPJ ' +
  'tende a ser decisiva cedo. Aplique a REGRA ZERO e a REGRA DE ENTRADA normalmente, com ' +
  'o mesmo cuidado e a mesma cordialidade. Não peça telefone logo de cara, o contato já ' +
  'está falando com você por aqui.';
// ══════════════════════════════════════════════════════════════
// ── WEBHOOK INSTAGRAM DIRECT
// ══════════════════════════════════════════════════════════════
app.get('/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('Webhook do Instagram verificado pela Meta com sucesso');
    return res.status(200).send(req.query['hub.challenge']);
  }
  console.log('Falha na verificação do webhook do Instagram. Token não confere.');
  return res.sendStatus(403);
});
app.post('/instagram', async (req, res) => {
  console.log('WEBHOOK INSTAGRAM:', JSON.stringify(req.body).substring(0, 700));
  res.status(200).json({ ok: true });
  try {
    const ev = eventoDeMensagem(req.body, IG_USER_ID);
    if (!ev) return;
    if (await jaProcessouMensagem(ev.mid)) {
      console.log('Evento de Instagram duplicado ignorado:', ev.mid);
      return;
    }
    if (!ev.texto || !ev.texto.trim()) {
      if (ev.mensagem.attachments || ev.mensagem.is_unsupported) {
        console.log('Mídia recebida no Instagram de', ev.psid);
        await enviarInstagram(ev.psid, 'Oi! Consigo ler só mensagens de texto por aqui. Pode escrever para mim o que você precisa?');
      }
      return;
    }
    console.log('Instagram, mensagem de', ev.psid, ':', ev.texto.substring(0, 100));
    await atenderCanalMeta({
      psid: ev.psid, texto: ev.texto, chave: chaveInstagram(ev.psid),
      canal: 'instagram', origem: 'bot-instagram',
      enviar: enviarInstagram, marcarVisto: marcarVistoInstagram, perfil: perfilInstagram,
      notaDeContexto: NOTA_INSTAGRAM
    });
  } catch(error) {
    console.error('Erro no webhook do Instagram:', error.message);
  }
});
// ══════════════════════════════════════════════════════════════
// ── WEBHOOK FACEBOOK MESSENGER
// ══════════════════════════════════════════════════════════════
app.get('/facebook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('Webhook do Messenger verificado pela Meta com sucesso');
    return res.status(200).send(req.query['hub.challenge']);
  }
  console.log('Falha na verificação do webhook do Messenger. Token não confere.');
  return res.sendStatus(403);
});
app.post('/facebook', async (req, res) => {
  console.log('WEBHOOK MESSENGER:', JSON.stringify(req.body).substring(0, 700));
  res.status(200).json({ ok: true });
  try {
    const ev = eventoDeMensagem(req.body, FB_PAGE_ID);
    if (!ev) return;
    if (await jaProcessouMensagem(ev.mid)) {
      console.log('Evento do Messenger duplicado ignorado:', ev.mid);
      return;
    }
    if (!ev.texto || !ev.texto.trim()) {
      if (ev.mensagem.attachments || ev.mensagem.is_unsupported) {
        console.log('Mídia recebida no Messenger de', ev.psid);
        await enviarFacebook(ev.psid, 'Oi! Consigo ler só mensagens de texto por aqui. Pode escrever para mim o que você precisa?');
      }
      return;
    }
    console.log('Messenger, mensagem de', ev.psid, ':', ev.texto.substring(0, 100));
    await atenderCanalMeta({
      psid: ev.psid, texto: ev.texto, chave: chaveFacebook(ev.psid),
      canal: 'facebook', origem: 'bot-facebook',
      enviar: enviarFacebook, marcarVisto: marcarVistoFacebook, perfil: perfilFacebook,
      notaDeContexto: NOTA_FACEBOOK
    });
  } catch(error) {
    console.error('Erro no webhook do Messenger:', error.message);
  }
});
// ── Guarda de acesso reutilizavel para as rotas internas.
// Antes so a inbox e o painel exigiam chave, e as rotas de diagnostico ficavam
// abertas na internet. Nao mostravam conversa, mas informavam a quem
// perguntasse quais integracoes existem e o nome da conta.
function exigeChave(req, res) {
  const esperada = process.env.INBOX_KEY;
  if (!esperada) {
    res.status(503).type('text/plain; charset=utf-8')
      .send('Rota protegida desativada. Falta criar a variavel INBOX_KEY no Render.');
    return false;
  }
  if (req.query.chave !== esperada) {
    res.status(403).type('text/plain; charset=utf-8').send('Chave invalida.');
    return false;
  }
  return true;
}
// ── ROTA: TESTAR O INSTAGRAM (protegida)
// Confirma token e conta sem mandar mensagem para ninguem.
// Com ?para=<IGSID>&texto=oi manda uma mensagem de teste.
app.get('/instagram-test', async (req, res) => {
  if (!exigeChave(req, res)) return;
  const tok = await tokenInstagram();
  const resultado = {
    host: IG_BASE,
    tokenConfigurado: !!tok,
    origemDoToken: igTokenOrigem,
    idadeDoTokenEmDias: idadeTokenEmDias(),
    userIdConfigurado: !!IG_USER_ID,
    verifyTokenConfigurado: !!META_VERIFY_TOKEN
  };
  if (!tok || !IG_USER_ID) {
    resultado.dica = 'Faltam INSTAGRAM_TOKEN e/ou INSTAGRAM_USER_ID no Render.';
    return res.status(503).json(resultado);
  }
  const r = await chamarInstagram('/me?fields=id,username,name');
  resultado.status = r.status;
  resultado.conta = r.data;
  if (!r.ok && r.data && r.data.error && r.data.error.code === 190) {
    resultado.diagnostico = 'Token rejeitado. Se a mensagem for "Cannot parse access token", ' +
      'o token provavelmente é de outro caminho de API. Esta instalação usa Instagram login, ' +
      'que fala com graph.instagram.com.';
  }
  if (req.query.para) {
    resultado.envioDeTeste = await enviarInstagram(req.query.para, req.query.texto || 'Teste do agente Ginger.');
  }
  res.json(resultado);
});
// ── ROTA: TESTAR O MESSENGER (protegida)
// Com ?para=<PSID>&texto=oi manda uma mensagem de teste.
app.get('/facebook-test', async (req, res) => {
  if (!exigeChave(req, res)) return;
  const resultado = {
    host: FB_BASE,
    tokenConfigurado: !!FB_TOKEN,
    pageIdConfigurado: !!FB_PAGE_ID,
    verifyTokenConfigurado: !!META_VERIFY_TOKEN
  };
  if (!FB_TOKEN) {
    resultado.dica = 'Falta FACEBOOK_PAGE_TOKEN no Render.';
    return res.status(503).json(resultado);
  }
  // ⚠️ TESTE A CAPACIDADE, NAO O CADASTRO ⚠️
  // Ler qualquer campo do no da Pagina, inclusive so o id, exige a permissao
  // pages_read_engagement. Ela nao tem relacao alguma com enviar mensagem, e
  // testar por ali fazia o verificador gritar falha num canal funcionando.
  // A caixa de conversas depende de pages_messaging, que e EXATAMENTE a
  // permissao que o bot usa. Se isso responde, o Messenger funciona.
  const r = await chamarFacebook('/me/conversations?limit=1');
  resultado.status = r.status;
  resultado.podeConversar = r.ok;
  resultado.idConfigurado = FB_PAGE_ID || null;
  if (!r.ok) resultado.erro = r.data;
  // Nome e enfeite: vem numa chamada separada que pode falhar em paz.
  const n = await chamarFacebook('/me?fields=name');
  resultado.nomeDaPagina = n.ok ? n.data.name
    : 'indisponível, falta pages_read_engagement (não impede o envio de mensagens)';
  // Nao da para confirmar o ID da Pagina sem pages_read_engagement, entao esta
  // rota nao tenta mais adivinhar. A trava principal contra eco e o campo
  // is_echo da propria Meta; o FACEBOOK_PAGE_ID e so uma segunda barreira.
  if (!r.ok && r.data && r.data.error) {
    const cod = r.data.error.code;
    if (cod === 190) {
      resultado.diagnostico = 'Token rejeitado. Confirme que é um token de PÁGINA, ' +
        'não o token do Instagram: o Messenger fala com graph.facebook.com e o ' +
        'Instagram com graph.instagram.com.';
    } else if (cod === 100) {
      resultado.diagnostico = 'A Meta não reconheceu o pedido. Em geral é token de ' +
        'usuário no lugar de token de Página, ou o token foi copiado incompleto. ' +
        'Gere de novo em Messenger API Settings, na coluna Token da Página.';
    }
  }
  if (req.query.para) {
    resultado.envioDeTeste = await enviarFacebook(req.query.para, req.query.texto || 'Teste do agente Ginger.');
  }
  res.json(resultado);
});
// ── ROTA: SITUAÇÃO E RENOVAÇÃO DO TOKEN DO INSTAGRAM (protegida)
// Com ?renovar=1 força a renovação na hora, sem esperar a rotina diária.
app.get('/instagram-status', async (req, res) => {
  if (!exigeChave(req, res)) return;
  await tokenInstagram();
  const out = {
    origemDoToken: igTokenOrigem,
    idadeDoTokenEmDias: idadeTokenEmDias(),
    renovaAutomaticamente: 'sim, rotina diária renova quando passa de 7 dias',
    observacao: igTokenOrigem === 'ambiente'
      ? 'O token ainda vem da variável de ambiente. Assim que a rotina rodar, ele passa a viver no Redis e a se renovar sozinho.'
      : 'O token vigente está no Redis e se renova sozinho. A variável do Render é apenas a semente inicial.'
  };
  if (req.query.renovar === '1') out.renovacao = await renovarTokenInstagram('pedido manual');
  res.json(out);
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
      range: `${SHEET_NAME}!A:O`
    });
    const rows = r.data.values || [];
    const faixas = { ate7: 0, ate15: 0, ate30: 0, ate45: 0, acima45: 0 };
    let semTelefone = 0, jaTratados = 0, elegiveis = 0, semCnpjDeclarado = 0;
    for (let i = 1; i < rows.length; i++) {
      const statusAtual = rows[i][8] || '';
      if (statusAtual.trim()) { jaTratados++; continue; }
      if (!limparTelefone(rows[i][3] || '')) { semTelefone++; continue; }
      if (!(rows[i][1] || '').trim()) continue;
      if (cnpjDeclaradoInexistente(rows[i][7] || '')) { semCnpjDeclarado++; continue; }
      if (isLeadRecente(rows[i][0] || '', dias * 24)) elegiveis++;
      if (isLeadRecente(rows[i][0] || '', 7 * 24)) faixas.ate7++;
      else if (isLeadRecente(rows[i][0] || '', 15 * 24)) faixas.ate15++;
      else if (isLeadRecente(rows[i][0] || '', 30 * 24)) faixas.ate30++;
      else if (isLeadRecente(rows[i][0] || '', 45 * 24)) faixas.ate45++;
      else faixas.acima45++;
    }
    // Puxa a qualidade do numero junto, para voce decidir a rampa sem
    // precisar abrir outra rota.
    // ATENCAO: no Render Hobby o servico dorme por inatividade. Na primeira
    // chamada depois de dormir, esta consulta a Meta pode nao voltar em tempo
    // e o campo cai em "desconhecida". Isso NAO significa numero ruim.
    // Se vier "desconhecida", chame a rota de novo ou use /phone-status.
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
      semCnpjDeclarado,
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
// Nota da sessao 22: a rota /metricas foi REMOVIDA. Ela devolvia em JSON o
// mesmo funil que o /painel mostra na tela, com filtros e tabela. Manter as
// duas significava corrigir a mesma conta em dois lugares.
// ══════════════════════════════════════════════════════════════
// ── INBOX: AUDITORIA DAS CONVERSAS
// ══════════════════════════════════════════════════════════════
// A Cloud API nao tem caixa de entrada. A aba Conversas guarda o historico,
// mas e um log cru, uma linha por mensagem, sem agrupar por pessoa.
// Esta rota le a aba e monta uma pagina de leitura, agrupada por contato,
// em formato de dialogo, mais recente primeiro, com atualizacao automatica.
//
// PROTECAO: o backend e publico. Esta pagina mostra nome, telefone, CNPJ e o
// teor das conversas, entao exige a chave da variavel INBOX_KEY do Render.
// Se a variavel nao existir, a rota se RECUSA a servir, em vez de abrir sem
// protecao. Falha fechada, nunca aberta.
function escaparHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// Converte "DD/MM/AAAA HH:MM:SS" em milissegundos, para ordenar.
function parseDataBrasil(str) {
  try {
    const [d, h] = String(str || '').split(' ');
    const [dia, mes, ano] = d.split('/').map(Number);
    const [hh, mm, ss] = (h || '0:0:0').split(':').map(Number);
    const t = new Date(ano, mes - 1, dia, hh || 0, mm || 0, ss || 0).getTime();
    return isNaN(t) ? 0 : t;
  } catch(e) {
    return 0;
  }
}
app.get('/inbox', async (req, res) => {
  const chaveEsperada = process.env.INBOX_KEY;
  if (!chaveEsperada) {
    return res.status(503).type('text/plain; charset=utf-8').send(
      'Inbox desativada.\n\n' +
      'Falta criar a variavel INBOX_KEY no Render.\n' +
      'Render, servico ginger-backend, aba Environment, Add Environment Variable.\n' +
      '  Key:   INBOX_KEY\n' +
      '  Value: uma senha qualquer escolhida por voce\n\n' +
      'Depois de salvar, acesse /inbox?chave=SUA_SENHA\n\n' +
      'Enquanto a variavel nao existir, esta pagina nao abre. Isso e proposital:\n' +
      'ela mostra nome, telefone, CNPJ e o conteudo das conversas dos leads, e o\n' +
      'backend esta aberto na internet.'
    );
  }
  if (req.query.chave !== chaveEsperada) {
    console.log('Tentativa de acesso ao /inbox com chave incorreta');
    return res.status(403).type('text/plain; charset=utf-8').send('Chave invalida.');
  }
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(500).type('text/plain').send('Sheets indisponivel');
    // Historico das conversas
    const rc = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_CONVERSAS}!A:E`
    });
    const linhas = (rc.data.values || []).slice(1);
    // Cadastro dos leads, para casar nome e empresa com o numero
    const rl = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:O`
    });
    const leads = {};
    for (const row of (rl.data.values || []).slice(1)) {
      const info = {
        data: row[0] || '', nome: row[1] || '', empresa: row[4] || '', cnpj: row[7] || '',
        status: row[8] || '', qualificacao: row[10] || '', motivo: row[11] || '',
        projeto: row[12] || ''
      };
      // Indexa pelas duas chaves possiveis: telefone e ID do canal. Sem a
      // segunda, todo contato de Instagram apareceria sem nome na inbox.
      const kTel = chaveNumero(row[3] || '');
      const kCanal = (row[COL_ID_CANAL] || '').trim();
      if (kTel) leads[kTel] = info;
      if (kCanal) leads[kCanal] = info;
    }
    // Agrupa por contato. Numero do WhatsApp usa a chave canonica, para nao
    // separar a mesma pessoa por causa do nono digito. Conversa do site nao
    // tem numero, entao a propria sessao vira a chave.
    const filtroNumero = req.query.numero ? chaveConversa(req.query.numero) : null;
    const grupos = {};
    for (const l of linhas) {
      const bruto = l[1] || '';
      // Linhas de diagnostico do /sheet-write-test nao sao contatos.
      if (!bruto || bruto === 'teste-escrita') continue;
      const chave = chaveConversa(bruto);
      if (!chave || chave === '55') continue;
      if (filtroNumero && chave !== filtroNumero) continue;
      if (!grupos[chave]) grupos[chave] = { chave, numeroBruto: bruto, mensagens: [] };
      grupos[chave].mensagens.push({
        quando: l[0] || '', ts: parseDataBrasil(l[0]),
        direcao: (l[2] || '').toLowerCase(), texto: l[3] || '', origem: l[4] || ''
      });
    }
    const contatos = Object.values(grupos);
    for (const c of contatos) {
      c.mensagens.sort((a, b) => a.ts - b.ts);
      c.ultima = c.mensagens.length ? c.mensagens[c.mensagens.length - 1].ts : 0;
      c.lead = leads[c.chave] || null;
      c.recebidas = c.mensagens.filter(m => m.direcao === 'recebida').length;
    }
    contatos.sort((a, b) => b.ultima - a.ultima);
    const LIMITE_CONTATOS = parseInt(req.query.limite) || 40;
    const mostrados = contatos.slice(0, LIMITE_CONTATOS);
    const totalRespondeu = contatos.filter(c => c.recebidas > 0).length;
    const badge = (txt, cor) => `<span class="tag" style="background:${cor}">${escaparHtml(txt)}</span>`;
    const corQual = q => {
      const u = String(q || '').toUpperCase();
      if (u === 'BOM') return '#1B7F4B';
      if (u === 'POTENCIAL_FUTURO') return '#B8860B';
      if (u === 'NAO_LEAD') return '#7A7A7A';
      if (u === 'RUIM') return '#C0392B';
      return '#47166B';
    };
    const blocos = mostrados.map(c => {
      const L = c.lead;
      const canal = canalDaChave(c.chave);
      const semNome = c.chave.startsWith('site-') ? 'Visitante do site'
        : c.chave.startsWith(IG_PREFIXO) ? 'Contato do Instagram' : c.chave;
      const titulo = L && L.nome ? `${L.nome}${L.empresa ? ' · ' + L.empresa : ''}` : semNome;
      // Data de entrada do lead. Vem da coluna A da planilha. Se o contato nao
      // tem linha na planilha (chamou o WhatsApp sem nunca preencher formulario),
      // cai para a data da primeira mensagem registrada.
      const dataEntrada = (L && L.data) ? String(L.data).split(' ')[0]
        : (c.mensagens.length ? String(c.mensagens[0].quando).split(' ')[0] : '');
      const tags = [];
      const corCanal = { Instagram: '#C13584', Facebook: '#1877F2', 'Chat do site': '#8A8792', WhatsApp: '#128C7E' };
      tags.push(badge(canal, corCanal[canal] || '#6E6E6E'));
      if (L && L.qualificacao) tags.push(badge(L.qualificacao, corQual(L.qualificacao)));
      if (L && L.status) tags.push(badge(L.status, '#6B4E8C'));
      if (L && L.projeto) tags.push(badge('projeto ' + L.projeto, '#1B7F4B'));
      if (c.recebidas === 0) tags.push(badge('sem resposta', '#B0B0B0'));
      const msgs = c.mensagens.map(m => {
        const eu = m.direcao === 'enviada';
        return `<div class="msg ${eu ? 'saiu' : 'entrou'}">
          <div class="bolha">${escaparHtml(m.texto).replace(/\n/g, '<br>')}</div>
          <div class="hora">${escaparHtml(m.quando)}${m.origem ? ' · ' + escaparHtml(m.origem) : ''}</div>
        </div>`;
      }).join('');
      return `<details class="contato"${filtroNumero ? ' open' : ''}>
        <summary>
          ${dataEntrada ? `<span class="data">${escaparHtml(dataEntrada)}</span>` : ''}
          <span class="nome">${escaparHtml(titulo)}</span>
          <span class="tags">${tags.join(' ')}</span>
          <span class="meta">${c.mensagens.length} msg${L && L.cnpj ? ' · CNPJ ' + escaparHtml(L.cnpj) : ''} · ${escaparHtml(c.numeroBruto)}</span>
        </summary>
        ${L && L.motivo ? `<div class="motivo">Motivo registrado: ${escaparHtml(L.motivo)}</div>` : ''}
        <div class="thread">${msgs}</div>
      </details>`;
    }).join('');
    const html = `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Inbox Ginger</title>
<style>
  :root { --roxo:#47166B; --lilas:#F2EAF7; --creme:#F8F8F8; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
         background:var(--creme); color:#222; font-size:15px; }
  header { background:var(--roxo); color:#fff; padding:14px 18px; position:sticky; top:0; z-index:10; }
  header h1 { margin:0; font-size:17px; font-weight:600; }
  header .resumo { font-size:13px; opacity:.85; margin-top:3px; }
  main { max-width:900px; margin:0 auto; padding:14px; }
  .contato { background:#fff; border:1px solid #E3D9EC; border-radius:8px; margin-bottom:10px; }
  summary { cursor:pointer; padding:12px 14px; list-style:none; }
  summary::-webkit-details-marker { display:none; }
  summary:hover { background:var(--lilas); }
  .data { display:inline-block; font-variant-numeric:tabular-nums; color:#52514e;
          background:#EFEAF4; border-radius:4px; padding:1px 6px; font-size:12px; margin-right:8px; }
  .nome { font-weight:600; color:var(--roxo); margin-right:8px; }
  .tags { display:inline; }
  .tag { display:inline-block; color:#fff; font-size:11px; padding:2px 7px;
         border-radius:10px; margin-right:4px; vertical-align:middle; }
  .meta { display:block; color:#777; font-size:12px; margin-top:4px; }
  .motivo { padding:8px 14px; background:var(--lilas); font-size:13px; color:#4a4a4a; }
  .thread { padding:12px 14px 16px; border-top:1px solid #EEE8F3; }
  .msg { margin-bottom:10px; display:flex; flex-direction:column; }
  .msg.entrou { align-items:flex-start; }
  .msg.saiu { align-items:flex-end; }
  .bolha { max-width:78%; padding:9px 12px; border-radius:12px; white-space:pre-wrap;
           word-break:break-word; line-height:1.4; }
  .entrou .bolha { background:#EFEFEF; border-bottom-left-radius:3px; }
  .saiu .bolha { background:var(--lilas); border-bottom-right-radius:3px; }
  .hora { font-size:11px; color:#999; margin-top:3px; }
  .vazio { padding:30px; text-align:center; color:#888; }
  footer { text-align:center; color:#999; font-size:12px; padding:18px; }
</style>
</head><body>
<header>
  <h1>Inbox Ginger</h1>
  <div class="resumo">${contatos.length} contatos · ${totalRespondeu} responderam · mostrando ${mostrados.length} · atualiza sozinha a cada 30s · ${escaparHtml(agoraBrasil())}</div>
</header>
<main>
  ${blocos || '<div class="vazio">Nenhuma conversa registrada ainda.</div>'}
  ${contatos.length > mostrados.length ? `<div class="vazio">Mais ${contatos.length - mostrados.length} contatos mais antigos. Acrescente &limite=200 no endereço para ver todos.</div>` : ''}
</main>
<footer>Clique num contato para abrir a conversa. Uso interno, contém dados pessoais de leads.</footer>
<script>
  // Guarda quais conversas estão abertas e a posição da rolagem, para o
  // refresh automático não fechar o que você está lendo.
  var ABERTOS = 'inbox_abertos';
  document.querySelectorAll('details.contato').forEach(function(d, i) {
    var k = d.querySelector('.meta') ? d.querySelector('.meta').textContent : String(i);
    try { if ((sessionStorage.getItem(ABERTOS) || '').split('|||').indexOf(k) > -1) d.open = true; } catch(e) {}
    d.addEventListener('toggle', function() {
      try {
        var lista = (sessionStorage.getItem(ABERTOS) || '').split('|||').filter(Boolean);
        var pos = lista.indexOf(k);
        if (d.open && pos === -1) lista.push(k);
        if (!d.open && pos > -1) lista.splice(pos, 1);
        sessionStorage.setItem(ABERTOS, lista.join('|||'));
      } catch(e) {}
    });
  });
  try {
    var y = sessionStorage.getItem('inbox_scroll');
    if (y) window.scrollTo(0, parseInt(y));
  } catch(e) {}
  setTimeout(function() {
    try { sessionStorage.setItem('inbox_scroll', String(window.scrollY)); } catch(e) {}
    location.reload();
  }, 30000);
</script>
</body></html>`;
    res.type('text/html; charset=utf-8').send(html);
  } catch(e) {
    console.error('Erro no /inbox:', e.message);
    res.status(500).type('text/plain; charset=utf-8').send('Erro ao montar a inbox: ' + e.message);
  }
});
// ══════════════════════════════════════════════════════════════
// ── PAINEL ANALITICO DOS LEADS DA INTERNET
// ══════════════════════════════════════════════════════════════
// Pagina de apresentacao. Mesma protecao da inbox (INBOX_KEY).
// Exemplo: /painel?chave=XXX&mes=8&ano=2026
//
// Estados de engajamento, mutuamente exclusivos e nesta ordem de precedencia:
//   nao abordado   -> coluna STATUS vazia, o bot ainda nao tocou
//   sem resposta   -> abordado, zero mensagens recebidas
//   abandonou      -> respondeu, sem qualificacao, calado ha mais de 24h
//   em conversa    -> respondeu, sem qualificacao, ativo nas ultimas 24h
//   qualificado    -> tem valor na coluna QUALIFICACAO
//
// "Sem resposta" e "abandonou" sao coisas diferentes e o painel separa as duas.
// A primeira mede se o template de abordagem funciona. A segunda mede se o
// agente perde a pessoa no meio da qualificacao. Somar as duas esconde qual
// dos dois problemas voce tem.
const PALETA = {
  // Validadas com scripts/validate_palette.js nos dois modos.
  // Rampa ordinal do funil (uma cor, monotona em luminosidade).
  funilClaro: ['#B98FD1', '#9C6BBB', '#7E48A2', '#632C87', '#47166B'],
  funilEscuro: ['#653F88', '#8054A8', '#9C6FC4', '#B98FD1', '#D4B4E5']
};
function fmtPct(a, b) {
  if (!b) return '—';
  return (Math.round((a / b) * 1000) / 10).toString().replace('.', ',') + '%';
}
app.get('/painel', async (req, res) => {
  if (!exigeChave(req, res)) return;
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(500).type('text/plain').send('Sheets indisponivel');
    const [rl, rc] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:O` }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_CONVERSAS}!A:E` })
    ]);
    const conv = {};
    for (const l of (rc.data.values || []).slice(1)) {
      const bruto = l[1] || '';
      if (!bruto || bruto === 'teste-escrita') continue;
      const chave = chaveConversa(bruto);
      if (!chave || chave === '55') continue;
      if (!conv[chave]) conv[chave] = { recebidas: 0, enviadas: 0, ultima: 0, total: 0 };
      const ts = parseDataBrasil(l[0]);
      const dir = (l[2] || '').toLowerCase();
      conv[chave].total++;
      if (dir === 'recebida') conv[chave].recebidas++; else conv[chave].enviadas++;
      if (ts >= conv[chave].ultima) conv[chave].ultima = ts;
    }
    const agoraMs = Date.now();
    const H24 = 24 * 3600 * 1000;
    const usadas = new Set();
    const leads = [];
    let projetosNoArquivoTodo = 0;
    // Manda TODOS os leads para o navegador, com mes e ano em cada um. Assim a
    // troca de mes e a comparacao com o mes anterior acontecem na hora, sem
    // recarregar a pagina e sem reler a planilha, que e a parte lenta.
    for (const row of (rl.data.values || []).slice(1)) {
      if ((row[12] || '').trim()) projetosNoArquivoTodo++;
      if (!(row[1] || '').trim() && !(row[3] || '').trim() && !(row[COL_ID_CANAL] || '').trim()) continue;
      const ma = mesAnoDaData(row[0] || '');
      const kTel = chaveNumero(row[3] || '');
      const kCanal = (row[COL_ID_CANAL] || '').trim();
      if (kTel) usadas.add(kTel);
      if (kCanal) usadas.add(kCanal);
      const c = (kCanal && conv[kCanal]) || (kTel && conv[kTel])
        || { recebidas: 0, enviadas: 0, ultima: 0, total: 0 };
      const status = (row[8] || '').trim();
      const qual = (row[10] || '').trim().toUpperCase();
      let estado;
      if (qual) estado = 'qualificado';
      else if (!status) estado = 'nao_abordado';
      else if (c.recebidas === 0) estado = 'sem_resposta';
      else if (c.ultima && (agoraMs - c.ultima) <= H24) estado = 'em_conversa';
      else estado = 'abandonou';
      leads.push({
        data: (row[0] || '').split(' ')[0],
        mes: ma ? ma.mes : 0, ano: ma ? ma.ano : 0,
        nome: row[1] || '', empresa: row[4] || '',
        origem: (row[9] || '').trim() || 'sem origem', qual, motivo: row[11] || '',
        projeto: (row[12] || '').trim(), msgs: c.total, recebidas: c.recebidas,
        ultima: c.ultima, estado,
        // Chave para abrir a conversa ao clicar na linha da tabela. Vai so a
        // chave, nunca o teor: o texto das conversas e buscado na hora do
        // clique, para nao entrar no arquivo que o Pedro baixa e compartilha.
        chave: kCanal || kTel || ''
      });
    }
    const orfas = Object.keys(conv).filter(k => !k.startsWith('site-') && !usadas.has(k)).length;
    const sessoesSite = Object.keys(conv).filter(k => k.startsWith('site-')).length;
    const brasil = new Date(Date.now() + (new Date().getTimezoneOffset() * 60000) + (-3 * 3600000));
    const DADOS = {
      leads, orfas, sessoesSite, projetosNoArquivoTodo,
      mesInicial: req.query.mes ? parseInt(req.query.mes) : brasil.getMonth() + 1,
      anoInicial: req.query.ano ? parseInt(req.query.ano) : brasil.getFullYear(),
      geradoEm: agoraBrasil()
    };
    const html = `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Painel de Leads da Internet — Ginger</title>
<style>
  .viz-root {
    color-scheme: light;
    --page:#F4F1F6; --surface:#FFFFFF;
    --ink:#191320; --ink2:#52514E; --muted:#8A8792;
    --grid:#E4DEEA; --trilho:#EFEAF4; --borda:rgba(25,19,32,0.10);
    --roxo:#47166B; --on-ink:#FFFFFF; --serie:#7E48A2; --serie-laranja:#F15A29;
    --f1:#B98FD1; --f2:#9C6BBB; --f3:#7E48A2; --f4:#632C87; --f5:#47166B;
    --st-bom:#0CA30C; --st-fut:#FAB219; --st-ruim:#D03B3B; --st-nao:#6E6E6E;
    --sobe:#0CA30C; --desce:#C0392B;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --page:#141019; --surface:#1A1620;
      --ink:#FFFFFF; --ink2:#C9C3D1; --muted:#9A93A5;
      --grid:#332B3D; --trilho:#26202F; --borda:rgba(255,255,255,0.10);
      --roxo:#D4B4E5; --on-ink:#1A1620; --serie:#A87FC4; --serie-laranja:#DD5F2C;
      --f1:#653F88; --f2:#8054A8; --f3:#9C6FC4; --f4:#B98FD1; --f5:#D4B4E5;
      --sobe:#2EA96B; --desce:#E0655C;
    }
  }
  /* Os MESMOS valores escuros sob o escopo do botao. A regra da media query
     cobre a preferencia do sistema operacional; esta cobre a escolha manual,
     e ela precisa vencer nos dois sentidos. O :not() acima deixa o modo claro
     forcado ganhar do sistema escuro, e o :where() mantem a media query com
     peso baixo o bastante para nao atropelar o botao. */
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --page:#141019; --surface:#1A1620;
    --ink:#FFFFFF; --ink2:#C9C3D1; --muted:#9A93A5;
    --grid:#332B3D; --trilho:#26202F; --borda:rgba(255,255,255,0.10);
    --roxo:#D4B4E5; --on-ink:#1A1620; --serie:#A87FC4; --serie-laranja:#DD5F2C;
    --f1:#653F88; --f2:#8054A8; --f3:#9C6FC4; --f4:#B98FD1; --f5:#D4B4E5;
    --sobe:#2EA96B; --desce:#E0655C;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--page); color:var(--ink);
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif; font-size:15px; }
  .wrap { max-width:1060px; margin:0 auto; padding:20px 16px 40px; }
  h1 { font-size:20px; margin:0; font-weight:600; color:var(--roxo); }
  .sub { color:var(--ink2); font-size:13px; margin:2px 0 16px; }
  .filtros { background:var(--surface); border:1px solid var(--borda); border-radius:10px;
    padding:10px 12px; margin-bottom:18px; }
  .fl { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .fl + .fl { margin-top:9px; padding-top:9px; border-top:1px solid var(--grid); }
  .fl .rotf { font-size:12px; color:var(--muted); min-width:74px; }
  .chip { color:var(--ink2); border:1px solid var(--borda); background:none;
    border-radius:7px; padding:5px 11px; font-size:13px; cursor:pointer; font-family:inherit; }
  .chip:hover { background:var(--trilho); }
  .chip.on { background:var(--roxo); color:var(--on-ink); border-color:var(--roxo); font-weight:600; }
  .periodo { font-weight:600; color:var(--ink); margin:0 4px; min-width:150px; text-align:center; }
  .dir { margin-left:auto; display:flex; gap:8px; }
  .card { background:var(--surface); border:1px solid var(--borda); border-radius:12px;
    padding:18px 20px; margin-bottom:14px; }
  .card h2 { font-size:14px; margin:0 0 2px; font-weight:600; color:var(--ink); }
  .card p.leg { font-size:12.5px; color:var(--muted); margin:0 0 14px; }
  .heroi { display:flex; align-items:center; gap:16px; }
  .heroi .n { font-size:56px; font-weight:600; line-height:1; color:var(--roxo); }
  .heroi .t1 { font-size:16px; font-weight:600; color:var(--ink); line-height:1.25; }
  .heroi .t2 { font-size:14px; color:var(--ink2); line-height:1.3; }
  .heroi-sub { font-size:13.5px; color:var(--ink2); margin:12px 0 0;
    padding-top:12px; border-top:1px solid var(--grid); }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:14px; }
  .kpi { background:var(--surface); border:1px solid var(--borda); border-radius:12px; padding:14px 16px; }
  .kpi .lab { font-size:12.5px; color:var(--muted); margin-bottom:6px; }
  .kpi .n { font-size:28px; font-weight:600; line-height:1.1; }
  .kpi .pe { font-size:12px; color:var(--ink2); margin-top:3px; }
  .delta { font-size:12px; margin-top:3px; font-weight:600; }
  .delta.up { color:var(--sobe); } .delta.down { color:var(--desce); } .delta.flat { color:var(--muted); font-weight:400; }
  .duas { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media (max-width:760px) { .duas { grid-template-columns:1fr; } }
  .linha { display:grid; grid-template-columns:minmax(160px,1.2fr) 3fr 42px;
    align-items:center; gap:10px; margin-bottom:8px; }
  .clic { cursor:pointer; }
  .clic:hover .trilho { outline:2px solid var(--grid); outline-offset:2px; border-radius:5px; }
  .linha.ativa .rot { color:var(--ink); font-weight:600; }
  .rot { font-size:13px; color:var(--ink2); }
  .rot .nota { display:block; font-size:11.5px; color:var(--muted); font-weight:400; }
  .sw { display:inline-block; width:10px; height:10px; border-radius:3px;
    margin-right:6px; vertical-align:baseline; }
  .trilho { background:var(--trilho); border-radius:4px; height:14px; }
  .marca { height:14px; border-radius:0 4px 4px 0; transition:width .25s; }
  .val { text-align:right; font-variant-numeric:tabular-nums; font-size:14px;
    font-weight:600; color:var(--ink); }
  .alerta { border-left:3px solid var(--st-fut); background:var(--trilho);
    border-radius:0 8px 8px 0; padding:12px 14px; font-size:13.5px; color:var(--ink2); margin-bottom:14px; }
  .alerta b { color:var(--ink); }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th { text-align:left; font-weight:600; color:var(--ink2); border-bottom:1px solid var(--grid);
    padding:7px 8px; white-space:nowrap; }
  td { padding:7px 8px; border-bottom:1px solid var(--grid); color:var(--ink2); vertical-align:top; }
  td.num { font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.obs { color:var(--muted); max-width:230px; }
  .rodape { color:var(--muted); font-size:12px; text-align:center; padding:16px 0 0; }
  .rolar { overflow-x:auto; }
  /* ── Leitor de conversa ──────────────────────────────────────────────────
     A linha da tabela vira um alvo de clique. O cursor e o realce no hover
     avisam que da para clicar, senao a funcao existe e ninguem descobre. */
  tr.temConversa { cursor:pointer; }
  tr.temConversa:hover td { background:var(--trilho); }
  .fundoModal { position:fixed; inset:0; background:rgba(0,0,0,0.45);
    display:flex; align-items:center; justify-content:center; padding:20px; z-index:50; }
  .modal { background:var(--surface); border:1px solid var(--borda); border-radius:12px;
    width:100%; max-width:680px; max-height:86vh; display:flex; flex-direction:column; }
  .modalTopo { display:flex; align-items:flex-start; gap:12px;
    padding:14px 18px; border-bottom:1px solid var(--grid); }
  .modalTopo h3 { margin:0; font-size:15px; font-weight:600; color:var(--ink); }
  .modalTopo .sub2 { font-size:12.5px; color:var(--muted); margin-top:2px; }
  .modalTopo button { margin-left:auto; }
  .modalCorpo { overflow-y:auto; padding:16px 18px; }
  /* Balao. O do lead encosta na esquerda, o do agente na direita, como em
     qualquer aplicativo de conversa: a posicao ja diz quem falou, sem rotulo. */
  .msg { max-width:78%; margin-bottom:10px; padding:9px 12px; border-radius:12px;
    font-size:13px; line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere; }
  .msg .hora { display:block; font-size:11px; color:var(--muted); margin-bottom:3px;
    font-variant-numeric:tabular-nums; }
  .msg.lead { background:var(--trilho); color:var(--ink); border:1px solid var(--borda);
    margin-right:auto; border-bottom-left-radius:4px; }
  .msg.agente { background:var(--roxo); color:var(--on-ink); margin-left:auto;
    border-bottom-right-radius:4px; }
  .msg.agente .hora { color:var(--on-ink); opacity:0.75; }
  .vazio { color:var(--muted); font-size:13px; text-align:center; padding:20px 0; }
  @media print { body{background:#fff;} .filtros,.rodape{display:none;} .fundoModal{display:none;} .card,.kpi{border:1px solid #ccc;break-inside:avoid;} }
</style>
</head><body class="viz-root" data-palette="#B98FD1,#9C6BBB,#7E48A2,#632C87,#47166B" data-mode="light">
<div class="wrap">
  <h1>Painel de Leads da Internet</h1>
  <div class="sub">Ginger Fragrance Design · gerado em ${escaparHtml(DADOS.geradoEm)}</div>
  <div class="filtros">
    <div class="fl navmes">
      <button class="chip" id="ant">←</button>
      <span class="periodo" id="rotuloPeriodo"></span>
      <button class="chip" id="prox">→</button>
      <button class="chip" id="btMes">Mês</button>
      <button class="chip" id="btTudo">Tudo</button>
      <span class="dir">
        <button class="chip" id="btTema" title="Alternar entre fundo claro e escuro"></button>
        <button class="chip" id="btCsv">Baixar CSV</button>
        <button class="chip" id="btHtml">Baixar painel</button>
        <button class="chip" id="limpar" hidden>Limpar filtros</button>
      </span>
    </div>
    <div class="fl"><span class="rotf">Canal</span><span id="f-origem"></span></div>
    <div class="fl"><span class="rotf">Qualificação</span><span id="f-qual"></span></div>
    <div class="fl"><span class="rotf">Estado</span><span id="f-estado"></span></div>
  </div>
  <div id="app"></div>
  <div class="rodape">Uso interno. Contém dados pessoais de leads. Clique nas barras para afunilar. Ctrl+P imprime ou salva em PDF.</div>
</div>
<script>
const D = ${JSON.stringify(DADOS)};
const F = { origem:null, qual:null, estado:null };
// ── Alternador claro / escuro ──────────────────────────────────────────────
// Tres estados de propósito: "sistema" respeita a preferência do computador,
// e os outros dois forçam. Sem o estado "sistema", quem nunca clicar no botão
// fica preso no que eu escolhi como padrão, em vez de no que ele já configurou.
// Valores possiveis: 'sistema', 'dark', 'light'. Os dois ultimos sao os
// mesmos nomes que o CSS espera em data-theme.
function temaSalvo(){ try { return localStorage.getItem('painel_tema') || 'sistema'; } catch(e){ return 'sistema'; } }
function estaEscuro(){
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function aplicaTema(t){
  const raiz = document.documentElement;
  if (t === 'sistema') raiz.removeAttribute('data-theme'); else raiz.dataset.theme = t;
  try { localStorage.setItem('painel_tema', t); } catch(e) {}
  const bt = document.getElementById('btTema');
  if (bt) {
    const escuro = estaEscuro();
    bt.textContent = escuro ? 'Fundo claro' : 'Fundo escuro';
    bt.title = 'Agora em modo ' + (escuro ? 'escuro' : 'claro') + '. Clique para trocar.';
  }
}
let MES = D.mesInicial, ANO = D.anoInicial, TODOS = false;
const MESES=['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const ROT_EST={qualificado:'Qualificado',sem_resposta:'Sem resposta',abandonou:'Parou de responder',em_conversa:'Em conversa',nao_abordado:'Não abordado'};
const NOTA_EST={sem_resposta:'abordado, nunca respondeu',abandonou:'respondeu e sumiu, sem devolutiva',em_conversa:'ativo nas últimas 24h',qualificado:'conversa concluída',nao_abordado:'ainda na fila'};
const NOTA_QUAL={BOM:'passou nos quatro critérios',POTENCIAL_FUTURO:'sem CNPJ, volume baixo ou não informado',RUIM:'sem projeto ou interesse real',NAO_LEAD:'fornecedor, cobrança, assunto interno'};
const TOK={BOM:'bom',POTENCIAL_FUTURO:'fut',RUIM:'ruim',NAO_LEAD:'nao'};
// Rotulos legiveis. "bot-planilha" nao significa nada para quem assiste a
// apresentacao; o nome do canal significa.
const ROT_ORIGEM={'bot-planilha':'WhatsApp, abordagem ativa','bot-site':'Site e WhatsApp receptivo',
 'bot-instagram':'Instagram Direct','bot-facebook':'Messenger','sem origem':'Sem origem registrada'};
const rotOrigem=o=>ROT_ORIGEM[o]||o;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function pct(a,b){return b?(Math.round((a/b)*1000)/10).toString().replace('.',',')+'%':'—';}
function doMes(m,a){return D.leads.filter(l=>l.mes===m&&l.ano===a);}
function base(){return TODOS?D.leads:doMes(MES,ANO);}
function aplicaFiltros(arr){return arr.filter(l=>(!F.origem||l.origem===F.origem)&&(!F.qual||l.qual===F.qual)&&(!F.estado||l.estado===F.estado));}
// Canal e categoria nominal, nao tem ordem. Pintar cada barra de um tom
// diferente do mesmo roxo faria o leitor procurar sentido numa diferenca que
// nao existe, e a barra ja carrega o tamanho. Uma cor so; quem identifica e o
// rotulo. Cinza fica reservado para ausencia de dado, que nao e um canal.
function corOrigem(o){return o==='sem origem'?'var(--muted)':'var(--serie)';}
function barra(o){const p=o.max>0?Math.max(o.valor>0?1.5:0,(o.valor/o.max)*100):0;
 return '<div class="linha '+(o.clic?'clic ':'')+(o.ativa?'ativa':'')+'"'+(o.clic?' data-f="'+o.dim+'" data-v="'+esc(o.chave)+'"':'')+'>'+
 '<div class="rot">'+(o.sw?'<span class="sw" style="background:var(--st-'+o.sw+')"></span>':'')+esc(o.rot)+
 (o.nota?'<span class="nota">'+esc(o.nota)+'</span>':'')+'</div>'+
 '<div class="trilho"><div class="marca" style="width:'+p+'%;background:'+o.cor+'"></div></div>'+
 '<div class="val">'+o.valor+'</div></div>';}
function chips(id,dim,vals,rot){document.getElementById(id).innerHTML=vals.map(v=>
 '<button class="chip '+(F[dim]===v?'on':'')+'" data-f="'+dim+'" data-v="'+esc(v)+'">'+esc(rot?rot(v):v)+'</button>').join(' ');}
// Comparacao com o mes anterior. Sem ela um numero sozinho nao diz se o
// canal melhorou ou piorou, que e a primeira pergunta em qualquer reunião.
function delta(atual,anterior){
 if(TODOS) return '';
 if(!anterior&&!atual) return '';
 if(!anterior) return '<div class="delta up">novo, sem base no mês anterior</div>';
 const d=atual-anterior;
 if(d===0) return '<div class="delta flat">igual ao mês anterior</div>';
 const cls=d>0?'up':'down';
 return '<div class="delta '+cls+'">'+(d>0?'+':'')+d+' vs '+MESES[MES===1?12:MES-1]+'</div>';}
function contas(arr){const n=e=>arr.filter(l=>l.estado===e).length,q=v=>arr.filter(l=>l.qual===v).length;
 return {captados:arr.length,abordados:arr.filter(l=>l.estado!=='nao_abordado').length,
 responderam:arr.filter(l=>l.recebidas>0).length,qualificados:arr.filter(l=>l.qual).length,
 bom:q('BOM'),futuro:q('POTENCIAL_FUTURO'),ruim:q('RUIM'),naoLead:q('NAO_LEAD'),
 projetos:arr.filter(l=>l.projeto).length,n};}
function csv(arr){
 const cab=['Entrada','Nome','Empresa','Canal','Estado','Qualificacao','Mensagens','Recebidas','Projeto','Motivo'];
 const esc2=s=>'"'+String(s==null?'':s).replace(/"/g,'""')+'"';
 const linhas=arr.map(l=>[l.data,l.nome,l.empresa,rotOrigem(l.origem),ROT_EST[l.estado]||l.estado,l.qual||'',l.msgs,l.recebidas,l.projeto||'',l.motivo].map(esc2).join(';'));
 const BOM=String.fromCharCode(65279), CRLF=String.fromCharCode(13,10);
 return BOM+[cab.map(esc2).join(';')].concat(linhas).join(CRLF);}
function render(){
 const L=aplicaFiltros(base());
 const C=contas(L);
 // Mes anterior sob os MESMOS filtros, para a comparacao ser honesta.
 const mAnt=MES===1?12:MES-1, aAnt=MES===1?ANO-1:ANO;
 const Cant=contas(aplicaFiltros(doMes(mAnt,aAnt)));
 const periodo=TODOS?'Todo o histórico':MESES[MES]+' de '+ANO;
 document.getElementById('rotuloPeriodo').textContent=periodo;
 document.getElementById('btMes').className='chip '+(TODOS?'':'on');
 document.getElementById('btTudo').className='chip '+(TODOS?'on':'');
 const porOrigem={}; L.forEach(l=>{porOrigem[l.origem]=(porOrigem[l.origem]||0)+1;});
 const origens=Object.entries(porOrigem).sort((a,b)=>b[1]-a[1]);
 const maxOrig=Math.max(...origens.map(o=>o[1]),1);
 const maxQual=Math.max(C.bom,C.futuro,C.ruim,C.naoLead,1);
 const maxEst=Math.max(C.n('sem_resposta'),C.n('abandonou'),C.n('em_conversa'),C.n('qualificado'),C.n('nao_abordado'),1);
 const etapas=[['Leads captados',C.captados],['Abordados pelo agente',C.abordados],['Responderam',C.responderam],['Qualificados como BOM',C.bom],['Projeto aberto',C.projetos]];
 const funil=etapas.map((e,i)=>{const p=C.captados>0?Math.max(e[1]>0?1.5:0,(e[1]/C.captados)*100):0;
  let nota=i===0?'':(etapas[i-1][1]>0?pct(e[1],etapas[i-1][1])+' da etapa anterior':'');
  if(i===4) nota=(nota?nota+' · ':'')+'anotado à mão pelo comercial';
  return '<div class="linha"><div class="rot">'+esc(e[0])+(nota?'<span class="nota">'+esc(nota)+'</span>':'')+'</div>'+
  '<div class="trilho"><div class="marca" style="width:'+p+'%;background:var(--f'+(i+1)+')"></div></div><div class="val">'+e[1]+'</div></div>';}).join('');
 const avisoProj = D.projetosNoArquivoTodo===0
  ? '<div class="alerta"><b>A etapa "Projeto aberto" ainda não tem dado.</b> Esse número não vem do Otimizah, vem da coluna PROJETO da planilha, preenchida à mão por quem abre o projeto. Nenhuma linha do arquivo inteiro está preenchida, então este zero significa "ninguém anotou ainda", e não "nenhum projeto foi aberto". Enquanto for assim, não leve essa linha para apresentação.</div>'
  : (C.projetos===0&&C.bom>0?'<div class="alerta"><b>Nenhum projeto anotado neste recorte</b>, embora existam leads BOM. Como o campo é preenchido à mão, pode ser ausência de projeto ou ausência de anotação. Confirme com o comercial antes de apresentar.</div>':'');
 const tab=L.slice().sort((a,b)=>(b.ultima||0)-(a.ultima||0)).map(l=>
  '<tr'+(l.chave&&l.msgs>0?' class="temConversa" data-conversa="'+esc(l.chave)+'" data-quem="'+esc((l.nome||'Contato')+(l.empresa?' · '+l.empresa:''))+'" title="Clique para ler a conversa"':'')+'>'+
  '<td class="num">'+esc(l.data)+'</td><td>'+esc(l.nome)+'</td><td>'+esc(l.empresa)+'</td>'+
  '<td>'+esc(rotOrigem(l.origem))+'</td><td>'+esc(ROT_EST[l.estado]||l.estado)+'</td>'+
  '<td>'+(l.qual?'<span class="sw" style="background:var(--st-'+(TOK[l.qual]||'nao')+')"></span>'+esc(l.qual):'—')+'</td>'+
  '<td class="num">'+l.msgs+'</td><td class="num">'+l.recebidas+'</td>'+
  '<td>'+(esc(l.projeto)||'—')+'</td><td class="obs">'+esc(l.motivo)+'</td></tr>').join('');
 const ativo=F.origem||F.qual||F.estado;
 document.getElementById('app').innerHTML=
 '<div class="card"><div class="heroi"><div class="n">'+C.bom+'</div><div>'+
  '<div class="t1">leads qualificados como BOM</div><div class="t2">'+esc(periodo)+(ativo?' · recorte filtrado':'')+'</div></div></div>'+
  '<p class="heroi-sub">De '+C.captados+' leads captados, '+C.responderam+' responderam ao agente e '+C.projetos+' viraram projeto aberto.</p></div>'+
 '<div class="kpis">'+
  '<div class="kpi"><div class="lab">Leads captados</div><div class="n">'+C.captados+'</div>'+delta(C.captados,Cant.captados)+'</div>'+
  '<div class="kpi"><div class="lab">Abordados</div><div class="n">'+C.abordados+'</div><div class="pe">'+pct(C.abordados,C.captados)+' dos captados</div></div>'+
  '<div class="kpi"><div class="lab">Responderam</div><div class="n">'+C.responderam+'</div><div class="pe">'+pct(C.responderam,C.abordados)+' dos abordados</div>'+delta(C.responderam,Cant.responderam)+'</div>'+
  '<div class="kpi"><div class="lab">Qualificados BOM</div><div class="n">'+C.bom+'</div><div class="pe">'+pct(C.bom,C.qualificados)+' dos qualificados</div>'+delta(C.bom,Cant.bom)+'</div>'+
  '<div class="kpi"><div class="lab">Projetos anotados</div><div class="n">'+C.projetos+'</div><div class="pe">'+pct(C.projetos,C.bom)+' dos BOM</div>'+delta(C.projetos,Cant.projetos)+'</div>'+
 '</div>'+
 '<div class="card"><h2>Funil, do lead captado ao projeto aberto</h2><p class="leg">Números absolutos. A nota abaixo do rótulo é a conversão em relação à etapa imediatamente anterior.</p>'+funil+'</div>'+
 avisoProj+
 '<div class="duas">'+
  '<div class="card"><h2>Como o agente classificou</h2><p class="leg">Clique numa barra para filtrar a página inteira por ela.</p>'+
  barra({rot:'BOM',valor:C.bom,max:maxQual,cor:'var(--serie)',sw:'bom',nota:NOTA_QUAL.BOM,clic:1,dim:'qual',chave:'BOM',ativa:F.qual==='BOM'})+
  barra({rot:'POTENCIAL_FUTURO',valor:C.futuro,max:maxQual,cor:'var(--serie)',sw:'fut',nota:NOTA_QUAL.POTENCIAL_FUTURO,clic:1,dim:'qual',chave:'POTENCIAL_FUTURO',ativa:F.qual==='POTENCIAL_FUTURO'})+
  barra({rot:'RUIM',valor:C.ruim,max:maxQual,cor:'var(--serie)',sw:'ruim',nota:NOTA_QUAL.RUIM,clic:1,dim:'qual',chave:'RUIM',ativa:F.qual==='RUIM'})+
  barra({rot:'NAO_LEAD',valor:C.naoLead,max:maxQual,cor:'var(--serie)',sw:'nao',nota:NOTA_QUAL.NAO_LEAD,clic:1,dim:'qual',chave:'NAO_LEAD',ativa:F.qual==='NAO_LEAD'})+
  '</div>'+
  '<div class="card"><h2>Onde o lead parou</h2><p class="leg">Estados exclusivos. "Sem resposta" mede o template de abordagem. "Parou de responder" mede o agente perdendo a pessoa no meio da conversa.</p>'+
  ['sem_resposta','abandonou','em_conversa','qualificado','nao_abordado'].map(e=>
   barra({rot:ROT_EST[e],valor:C.n(e),max:maxEst,cor:'var(--serie)',nota:NOTA_EST[e],clic:1,dim:'estado',chave:e,ativa:F.estado===e})).join('')+
  '</div></div>'+
 '<div class="card"><h2>Canais</h2><p class="leg">De onde o lead entrou. Clique para ver o funil de um canal só.</p>'+
  (origens.map(o=>barra({rot:rotOrigem(o[0]),valor:o[1],max:maxOrig,cor:corOrigem(o[0]),clic:1,dim:'origem',chave:o[0],ativa:F.origem===o[0]})).join('')
   ||'<p class="leg">Sem leads neste recorte.</p>')+'</div>'+
 (D.orfas?'<div class="alerta"><b>'+D.orfas+' conversa'+(D.orfas>1?'s':'')+' de WhatsApp sem linha na planilha.</b> São contatos anteriores à correção que criou linha automaticamente. Conversaram com o agente mas não têm linha, então não aparecem em nenhum número desta página. Daqui para frente todo contato novo já nasce com linha.'+
  (D.sessoesSite?' Além delas, '+D.sessoesSite+' sessão'+(D.sessoesSite>1?'ões':'')+' do chat do site, que por natureza não têm telefone.':'')+'</div>':'')+
 '<div class="card"><h2>Tabela completa</h2><p class="leg">'+L.length+' lead'+(L.length===1?'':'s')+' neste recorte. Nenhum número desta página depende de passar o mouse em nada, tudo está aqui.</p>'+
  '<div class="rolar"><table><thead><tr><th>Entrada</th><th>Nome</th><th>Empresa</th><th>Canal</th><th>Estado</th><th>Qualificação</th><th>Msgs</th><th>Recebidas</th><th>Projeto</th><th>Motivo</th></tr></thead>'+
  '<tbody>'+(tab||'<tr><td colspan="10">Nenhum lead neste recorte.</td></tr>')+'</tbody></table></div></div>';
 const origensTodas=[...new Set(D.leads.map(l=>l.origem))].sort();
 chips('f-origem','origem',origensTodas,rotOrigem);
 chips('f-qual','qual',['BOM','POTENCIAL_FUTURO','RUIM','NAO_LEAD']);
 chips('f-estado','estado',['sem_resposta','abandonou','em_conversa','qualificado','nao_abordado'],v=>ROT_EST[v]);
 document.getElementById('limpar').hidden=!ativo;
}
document.addEventListener('click',ev=>{
 const alvo=ev.target.closest('[data-f]');
 if(alvo){const d=alvo.dataset.f,v=alvo.dataset.v;F[d]=(F[d]===v?null:v);render();return;}
 const id=ev.target.id;
 if(id==='limpar'){F.origem=F.qual=F.estado=null;render();}
 // Troca de mes sem recarregar: os dados de todos os meses ja estao aqui.
 else if(id==='ant'){TODOS=false;if(MES===1){MES=12;ANO--;}else MES--;render();}
 else if(id==='prox'){TODOS=false;if(MES===12){MES=1;ANO++;}else MES++;render();}
 else if(id==='btMes'){TODOS=false;render();}
 else if(id==='btTudo'){TODOS=true;render();}
 else if(id==='btTema'){ aplicaTema(estaEscuro()?'light':'dark'); }
 else if(id==='btCsv'){
  const arr=aplicaFiltros(base());
  const b=new Blob([csv(arr)],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(b);
  a.download='leads-ginger-'+(TODOS?'historico':ANO+'-'+String(MES).padStart(2,'0'))+'.csv';
  a.click(); URL.revokeObjectURL(a.href);
 }
 // Baixa o painel inteiro como um arquivo unico, para o Pedro compartilhar sem
 // dar a chave de acesso a ninguem. A pagina ja e autossuficiente: CSS, script
 // e dados vao todos dentro do HTML, entao o arquivo salvo continua com filtros
 // e troca de mes funcionando, mesmo sem internet. O botao sai da copia para
 // quem receber nao clicar em "baixar" dentro de um arquivo baixado.
 else if(id==='btHtml'){
  const copia=document.documentElement.cloneNode(true);
  const bt=copia.querySelector('#btHtml'); if(bt) bt.remove();
  const lr=copia.querySelector('#leitor'); if(lr) lr.remove();
  const doc='<!DOCTYPE html>'+copia.outerHTML;
  const b=new Blob([doc],{type:'text/html;charset=utf-8;'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(b);
  a.download='painel-ginger-'+(TODOS?'historico':ANO+'-'+String(MES).padStart(2,'0'))+'.html';
  a.click(); URL.revokeObjectURL(a.href);
 }
});
// ── Leitor de conversa ─────────────────────────────────────────────────────
// A chave de acesso e lida da barra de enderecos NA HORA do clique, nunca
// gravada no HTML. Assim o arquivo que o Pedro baixa e compartilha nao carrega
// a chave junto: quem receber ve as metricas e nao consegue abrir conversa.
function chaveDaUrl(){
  try { return new URLSearchParams(location.search).get('chave')||''; } catch(e){ return ''; }
}
function fechaConversa(){
  const f=document.getElementById('leitor'); if(f) f.remove();
  document.removeEventListener('keydown',escFecha);
  // Solta a pagina de tras. Sem isso, quem rola a conversa longa acaba
  // rolando o painel por baixo e se perde ao fechar.
  document.body.style.overflow='';
}
function escFecha(e){ if(e.key==='Escape') fechaConversa(); }
function abreConversa(contato,quem){
  fechaConversa();
  const f=document.createElement('div');
  f.className='fundoModal'; f.id='leitor';
  f.innerHTML='<div class="modal" role="dialog" aria-modal="true" aria-label="Conversa">'+
    '<div class="modalTopo"><div><h3>'+esc(quem)+'</h3>'+
    '<div class="sub2" id="lrSub">carregando…</div></div>'+
    '<button class="chip" id="lrFechar">Fechar</button></div>'+
    '<div class="modalCorpo" id="lrCorpo"><div class="vazio">Buscando a conversa…</div></div></div>';
  document.body.appendChild(f);
  document.body.style.overflow='hidden';
  // Clique no fundo escuro fecha. Clique dentro do painel branco, nao.
  f.addEventListener('click',ev=>{ if(ev.target===f) fechaConversa(); });
  document.getElementById('lrFechar').addEventListener('click',fechaConversa);
  document.addEventListener('keydown',escFecha);
  const ch=chaveDaUrl();
  if(!ch){
    document.getElementById('lrSub').textContent='indisponível neste arquivo';
    document.getElementById('lrCorpo').innerHTML='<div class="vazio">Este é um arquivo baixado do painel. '+
      'Ele guarda os números, mas não o texto das conversas, de propósito. '+
      'Para ler a conversa, abra o painel no endereço original.</div>';
    return;
  }
  fetch('/conversa?chave='+encodeURIComponent(ch)+'&contato='+encodeURIComponent(contato))
   .then(r=>r.ok?r.json():Promise.reject(new Error('resposta '+r.status)))
   .then(d=>{
     const sub=document.getElementById('lrSub'), corpo=document.getElementById('lrCorpo');
     if(!sub||!corpo) return;
     sub.textContent=d.canal+' · '+d.total+' mensagens, '+d.recebidas+' do lead';
     corpo.innerHTML=d.mensagens.length
      ? d.mensagens.map(m=>'<div class="msg '+(m.quem==='lead'?'lead':'agente')+'">'+
          '<span class="hora">'+esc(m.data)+'</span>'+esc(m.texto)+'</div>').join('')
      : '<div class="vazio">Nenhuma mensagem registrada para este contato.</div>';
   })
   .catch(e=>{
     const sub=document.getElementById('lrSub'), corpo=document.getElementById('lrCorpo');
     if(sub) sub.textContent='falhou';
     if(corpo) corpo.innerHTML='<div class="vazio">Não consegui carregar a conversa. '+esc(e.message)+'</div>';
   });
}
document.addEventListener('click',e=>{
  const tr=e.target.closest&&e.target.closest('tr.temConversa');
  if(tr) abreConversa(tr.dataset.conversa,tr.dataset.quem||'Contato');
});
// Se o usuario nunca escolheu, segue o sistema. Se escolheu, a escolha manda.
aplicaTema(temaSalvo());
// Quando esta em "sistema" e o computador troca de tema, o rotulo acompanha.
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (temaSalvo() === 'sistema') aplicaTema('sistema');
  });
} catch(e) {}
render();
</script>
</body></html>`;
    res.type('text/html; charset=utf-8').send(html);
  } catch(e) {
    console.error('Erro no /painel:', e.message);
    res.status(500).type('text/plain; charset=utf-8').send('Erro ao montar o painel: ' + e.message);
  }
});
// ══════════════════════════════════════════════════════════════
// ── ROTA: MIGRAR QUALIFICAÇÕES PRESAS NA COLUNA I
// ══════════════════════════════════════════════════════════════
// Ate a sessao 22, o bot gravava a classificacao na coluna I, a mesma que
// guardava o estado operacional. A reestruturacao separou os dois eixos e a
// classificacao passou para a coluna K, mas os dados ANTIGOS ficaram onde
// estavam. Resultado: todo lead qualificado antes do deploy tem o "BOM" preso
// na coluna errada, e o painel, que conta pela K, nao o enxerga.
//
// Esta rota e de mao unica e roda uma vez. Por padrao ela apenas MOSTRA o que
// faria. Só muda a planilha com &aplicar=1.
const CLASSIFICACOES_VALIDAS = ['BOM', 'POTENCIAL_FUTURO', 'RUIM', 'NAO_LEAD'];
// ══════════════════════════════════════════════════════════════
// ── ROTA: CONVERSA DE UM CONTATO (JSON, para o painel)
// ══════════════════════════════════════════════════════════════
// Serve o historico de UM contato, para o painel abrir ao clicar na linha da
// tabela. Deliberadamente separada do painel: se o teor das conversas fosse
// junto com os dados do painel, ele entraria no arquivo HTML que o Pedro baixa
// para compartilhar, e ai um arquivo de metricas passaria a carregar a conversa
// inteira de 65 pessoas. Aqui o texto so sai quando alguem pede, uma pessoa
// por vez, com a chave na mao.
app.get('/conversa', async (req, res) => {
  if (!exigeChave(req, res)) return;
  const pedido = (req.query.contato || '').trim();
  if (!pedido) return res.status(400).json({ erro: 'informe contato' });
  const alvo = chaveConversa(pedido);
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(500).json({ erro: 'sheets indisponivel' });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_CONVERSAS}!A:E`
    });
    const mensagens = [];
    for (const l of (r.data.values || []).slice(1)) {
      if (chaveConversa(l[1] || '') !== alvo) continue;
      mensagens.push({
        data: l[0] || '',
        quem: (l[2] || '').toLowerCase() === 'recebida' ? 'lead' : 'agente',
        texto: l[3] || ''
      });
    }
    mensagens.sort((a, b) => parseDataBrasil(a.data) - parseDataBrasil(b.data));
    res.json({
      contato: alvo, canal: canalDaChave(alvo),
      total: mensagens.length,
      recebidas: mensagens.filter(m => m.quem === 'lead').length,
      mensagens
    });
  } catch(e) {
    console.error('Erro ao buscar conversa:', e.message);
    res.status(500).json({ erro: e.message });
  }
});
// ══════════════════════════════════════════════════════════════
// ── ROTA: DIAGNÓSTICO DAS LINHAS
// ══════════════════════════════════════════════════════════════
// Chegaram e-mails de lead BOM que o painel nao conta. Ou a classificacao foi
// gravada em outra coluna, ou nao foi gravada em lugar nenhum. Estas duas
// hipoteses pedem tratamentos opostos, e nao da para escolher no escuro.
// Esta rota mostra o conteudo cru das colunas que importam, sem interpretar.
app.get('/diagnostico-linhas', async (req, res) => {
  if (!exigeChave(req, res)) return;
  const busca = (req.query.busca || '').trim().toLowerCase();
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(500).json({ erro: 'sheets indisponivel' });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:O`
    });
    const rows = r.data.values || [];
    const corta = v => { const s = String(v == null ? '' : v); return s.length > 90 ? s.substring(0, 90) + '…' : s; };
    const linhas = [];
    for (let i = 1; i < rows.length; i++) {
      const l = rows[i] || [];
      const alvo = `${l[1] || ''} ${l[3] || ''} ${l[4] || ''}`.toLowerCase();
      if (busca && !alvo.includes(busca)) continue;
      linhas.push({
        linha: i + 1,
        A_data: corta(l[0]), B_nome: corta(l[1]), D_telefone: corta(l[3]), E_empresa: corta(l[4]),
        H_cnpj: corta(l[7]), I_status: corta(l[8]), J_origem: corta(l[9]),
        K_qualificacao: corta(l[10]), L_motivo: corta(l[11]),
        M_projeto: corta(l[12]), O_id_canal: corta(l[14])
      });
    }
    const semNada = linhas.filter(x => !x.I_status && !x.K_qualificacao).length;
    res.json({
      totalDeLinhas: rows.length - 1,
      mostrando: linhas.length,
      semStatusEsemQualificacao: semNada,
      dica: 'use ?busca=maycon para filtrar por nome, telefone ou empresa',
      linhas: linhas.slice(-80)
    });
  } catch(e) {
    console.error('Erro no diagnóstico de linhas:', e.message);
    res.status(500).json({ erro: e.message });
  }
});
// ══════════════════════════════════════════════════════════════
// ── ROTA: RECUPERAR CONVERSAS ÓRFÃS
// ══════════════════════════════════════════════════════════════
// Ate hoje, so ganhava linha na planilha quem ja estava na lista de abordagem
// ativa ou preencheu o formulario do site. Quem chamou no WhatsApp por conta
// propria conversou, foi qualificado e gerou e-mail para o comercial SEM
// nunca existir na planilha. O painel le a planilha, entao esses leads sao
// invisiveis nas metricas. Esta rota devolve uma linha para cada um deles.
// Ela nao inventa classificacao: cria a linha com o historico que existe e
// deixa a qualificacao em branco, para o comercial ou o proprio agente
// preencherem. Inventar um BOM aqui seria pior do que a falta que ele faz.
app.get('/recuperar-orfaos', async (req, res) => {
  if (!exigeChave(req, res)) return;
  const aplicar = req.query.aplicar === '1';
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(500).json({ erro: 'sheets indisponivel' });
    const [rl, rc] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:O` }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_CONVERSAS}!A:E` })
    ]);
    // Todas as chaves que JA tem linha, pelo telefone ou pelo ID do canal.
    const comLinha = new Set();
    for (const row of (rl.data.values || []).slice(1)) {
      const kTel = chaveNumero(row[3] || '');
      const kCanal = (row[COL_ID_CANAL] || '').trim();
      if (kTel) comLinha.add(kTel);
      if (kCanal) comLinha.add(kCanal);
    }
    // Agrupa o historico por contato.
    const porChave = {};
    for (const l of (rc.data.values || []).slice(1)) {
      const bruto = l[1] || '';
      if (!bruto || bruto === 'teste-escrita') continue;
      const chave = chaveConversa(bruto);
      // Sessao anonima do site nao vira lead: nao tem telefone nem nome, e
      // cada visita gera uma sessao nova. Viraria lixo na planilha.
      if (!chave || chave === '55' || chave.startsWith('site-')) continue;
      if (comLinha.has(chave)) continue;
      if (!porChave[chave]) porChave[chave] = { chave, primeira: '', recebidas: 0, enviadas: 0, origem: '', amostra: '' };
      const g = porChave[chave];
      const ts = parseDataBrasil(l[0]);
      if (!g.primeira || ts < parseDataBrasil(g.primeira)) g.primeira = l[0] || '';
      if ((l[2] || '').toLowerCase() === 'recebida') {
        g.recebidas++;
        if (!g.amostra) g.amostra = String(l[3] || '').substring(0, 80);
      } else g.enviadas++;
      if (!g.origem && (l[4] || '').trim()) g.origem = (l[4] || '').trim();
    }
    const orfaos = Object.values(porChave).sort(
      (a, b) => parseDataBrasil(a.primeira) - parseDataBrasil(b.primeira));
    const monta = o => {
      const ehIg = o.chave.startsWith(IG_PREFIXO), ehFb = o.chave.startsWith(FB_PREFIXO);
      return {
        data: o.primeira || agoraBrasil(),
        telefone: (ehIg || ehFb) ? '' : o.chave,
        idCanal: o.chave,
        origem: o.origem || (ehIg ? 'bot-instagram' : ehFb ? 'bot-facebook' : 'bot-site'),
        status: 'recuperado do histórico',
        canal: canalDaChave(o.chave),
        mensagens: o.recebidas + o.enviadas, recebidas: o.recebidas,
        primeiraFala: o.amostra
      };
    };
    const previa = orfaos.map(monta);
    if (!aplicar) {
      return res.json({
        modo: 'PRÉVIA, nada foi alterado',
        vaiCriar: previa.length,
        contatos: previa,
        comoAplicar: 'acrescente &aplicar=1 no endereço',
        oQueAcontece: 'Cada contato ganha UMA linha nova na planilha, com a data da ' +
          'primeira mensagem, o telefone e o canal. A qualificação fica em branco de ' +
          'propósito: o agente preenche na próxima mensagem, ou o comercial preenche à mão ' +
          'pelo e-mail que já recebeu. Nenhuma linha existente é tocada.'
      });
    }
    const criadas = [];
    for (const o of previa) {
      const rowIndex = await criarLinhaLead(o);
      if (rowIndex) {
        await setLinhaCache(o.idCanal, rowIndex);
        criadas.push({ linha: rowIndex, ...o });
      }
    }
    console.log(`Recuperação de órfãos: ${criadas.length} linha(s) criadas`);
    res.json({
      modo: 'APLICADO', criadas: criadas.length, contatos: criadas,
      proximoPasso: 'Abra o painel. Esses contatos passam a aparecer em "Leads captados". ' +
        'Para contá-los como BOM, preencha a coluna K com a classificação do e-mail que você recebeu.'
    });
  } catch(e) {
    console.error('Erro ao recuperar órfãos:', e.message);
    res.status(500).json({ erro: e.message });
  }
});
// ══════════════════════════════════════════════════════════════
// ── ROTA: MARCAR LINHAS REPETIDAS DO MESMO CONTATO
// ══════════════════════════════════════════════════════════════
// Tres mensagens seguidas geravam tres linhas para o mesmo ID de canal. A
// trava em garantirLinhaDoContato impede novos casos; esta rota trata os que
// ja estao na planilha. Ela NAO apaga nada: marca as repetidas na coluna I,
// para que parem de inflar a contagem de leads captados sem perder o registro.
app.get('/marcar-duplicados-canal', async (req, res) => {
  if (!exigeChave(req, res)) return;
  const aplicar = req.query.aplicar === '1';
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(500).json({ erro: 'sheets indisponivel' });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:O`
    });
    const rows = r.data.values || [];
    const vistos = {}, repetidas = [];
    for (let i = 1; i < rows.length; i++) {
      const id = (rows[i][COL_ID_CANAL] || '').trim();
      if (!id) continue;
      if (!vistos[id]) { vistos[id] = i + 1; continue; }
      // Nunca marcar uma linha que ja tem classificacao: e a linha util.
      if ((rows[i][10] || '').trim()) continue;
      repetidas.push({
        linha: i + 1, nome: rows[i][1] || '', idCanal: id,
        primeiraLinhaDesseContato: vistos[id], statusAtual: rows[i][8] || ''
      });
    }
    if (!aplicar) {
      return res.json({
        modo: 'PRÉVIA, nada foi alterado', vaiMarcar: repetidas.length, linhas: repetidas,
        comoAplicar: 'acrescente &aplicar=1 no endereço',
        oQueAcontece: 'A coluna I dessas linhas passa a dizer "linha repetida do mesmo contato". ' +
          'Nada é apagado e a primeira linha de cada contato fica intacta.'
      });
    }
    if (repetidas.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: repetidas.map(x => ({
            range: `${SHEET_NAME}!I${x.linha}`,
            values: [['linha repetida do mesmo contato']]
          }))
        }
      });
    }
    console.log(`Duplicados por ID de canal: ${repetidas.length} linha(s) marcadas`);
    res.json({ modo: 'APLICADO', marcadas: repetidas.length, linhas: repetidas });
  } catch(e) {
    console.error('Erro ao marcar duplicados:', e.message);
    res.status(500).json({ erro: e.message });
  }
});
app.get('/migrar-qualificacao', async (req, res) => {
  if (!exigeChave(req, res)) return;
  const aplicar = req.query.aplicar === '1';
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(500).json({ erro: 'sheets indisponivel' });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:O`
    });
    const rows = r.data.values || [];
    const mover = [], conflitos = [];
    for (let i = 1; i < rows.length; i++) {
      const statusI = (rows[i][8] || '').trim().toUpperCase();
      const qualK = (rows[i][10] || '').trim();
      if (!CLASSIFICACOES_VALIDAS.includes(statusI)) continue;
      const info = { linha: i + 1, nome: rows[i][1] || '', empresa: rows[i][4] || '', classificacao: statusI };
      // Se a K ja tem valor, nao sobrescreve: a K e mais nova e mais confiavel.
      if (qualK) { conflitos.push({ ...info, jaNaColunaK: qualK }); continue; }
      mover.push(info);
    }
    if (!aplicar) {
      return res.json({
        modo: 'PRÉVIA, nada foi alterado',
        vaiMover: mover.length,
        linhas: mover,
        ignoradasPorJaTerValorEmK: conflitos,
        comoAplicar: 'acrescente &aplicar=1 no endereço',
        oQueAcontece: 'A classificação sai da coluna I e vai para a K. A coluna I ' +
          'recebe "qualificado pelo agente", que é o estado operacional correspondente. ' +
          'A coluna L, MOTIVO, fica como está.'
      });
    }
    const data = [];
    for (const m of mover) {
      data.push({ range: `${SHEET_NAME}!I${m.linha}`, values: [['qualificado pelo agente']] });
      data.push({ range: `${SHEET_NAME}!K${m.linha}`, values: [[m.classificacao]] });
    }
    if (data.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data }
      });
    }
    console.log(`Migração de qualificação: ${mover.length} linha(s) movidas da coluna I para a K`);
    res.json({
      modo: 'APLICADO',
      movidas: mover.length,
      linhas: mover,
      ignoradasPorJaTerValorEmK: conflitos,
      proximoPasso: 'Abra o painel: os números de agosto devem subir.'
    });
  } catch(e) {
    console.error('Erro na migração de qualificação:', e.message);
    res.status(500).json({ erro: e.message });
  }
});
// ══════════════════════════════════════════════════════════════
// ── ROTA: SAÚDE DO SISTEMA
// ══════════════════════════════════════════════════════════════
// O modo de falha mais perigoso deste bot nao e um erro na tela, e o silencio.
// Se o saldo da Anthropic acabar, o Redis cair, a permissao da planilha mudar
// ou o token do Instagram vencer, nada quebra visivelmente: o bot simplesmente
// para de responder e ninguem percebe ate alguem reclamar dias depois.
// Esta rota checa tudo de uma vez e diz, em uma palavra, se esta tudo de pe.
app.get('/saude', async (req, res) => {
  if (!exigeChave(req, res)) return;
  const checagens = [];
  const add = (nome, ok, detalhe, critico = true) =>
    checagens.push({ nome, situacao: ok ? 'ok' : (critico ? 'FALHOU' : 'atenção'), detalhe });
  // Redis
  try {
    const p = await redis('PING');
    add('Redis (memória das conversas)', p === 'PONG', p === 'PONG' ? 'respondendo' : 'sem resposta');
  } catch(e) { add('Redis (memória das conversas)', false, e.message); }
  // Planilha, leitura e escrita
  try {
    const sheets = await getSheetsClient();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:O1`
    });
    const cab = (r.data.values && r.data.values[0]) || [];
    add('Planilha, leitura', cab.length > 0, `${cab.length} colunas no cabeçalho`);
    add('Planilha, coluna ID_CANAL', cab[COL_ID_CANAL] === 'ID_CANAL',
      cab[COL_ID_CANAL] === 'ID_CANAL' ? 'presente' : 'FALTA rodar /corrigir-cabecalhos');
  } catch(e) { add('Planilha', false, e.message); }
  // Claude
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] })
    });
    const d = await r.json();
    add('Claude (cérebro do agente)', !!d.content, d.content ? 'respondendo' :
      (d.error && d.error.message || 'sem resposta').substring(0, 120));
  } catch(e) { add('Claude (cérebro do agente)', false, e.message); }
  // WhatsApp
  try {
    const r = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_ID}?fields=quality_rating,status`,
      { headers: { 'Authorization': `Bearer ${WA_TOKEN}` } }
    );
    const d = await r.json();
    const conectado = d.status === 'CONNECTED';
    add('WhatsApp, número', conectado, `status ${d.status || '?'}, qualidade ${d.quality_rating || '?'}`);
    add('WhatsApp, qualidade', d.quality_rating === 'GREEN',
      `${d.quality_rating || 'desconhecida'}`, false);
  } catch(e) { add('WhatsApp, número', false, e.message); }
  // Instagram
  if (IG_TOKEN || igTokenCache) {
    const r = await chamarInstagram('/me?fields=id,username');
    add('Instagram, token', r.ok, r.ok ? `conta @${r.data.username}` :
      ((r.data.error && r.data.error.message) || 'rejeitado').substring(0, 140));
    const dias = idadeTokenEmDias();
    add('Instagram, idade do token', dias === null || dias < 55,
      dias === null ? 'ainda não registrada' : `${dias} dia(s), renova sozinho aos 7`, false);
  } else {
    add('Instagram', false, 'não configurado', false);
  }
  // Facebook Messenger
  if (FB_TOKEN) {
    // Testa a caixa de conversas, que depende de pages_messaging, a mesma
    // permissao que o bot usa para responder. Ler o cadastro da Pagina exige
    // outra permissao, sem relacao com o atendimento, e checar aquilo aqui
    // transformava enfeite em alarme de incendio.
    const r = await chamarFacebook('/me/conversations?limit=1');
    add('Messenger, capacidade de conversar', r.ok,
      r.ok ? 'pages_messaging respondendo'
           : ((r.data.error && r.data.error.message) || 'rejeitado').substring(0, 160));
  } else {
    add('Messenger', false, 'não configurado', false);
  }
  const falhas = checagens.filter(c => c.situacao === 'FALHOU');
  const atencoes = checagens.filter(c => c.situacao === 'atenção');
  res.status(falhas.length ? 500 : 200).json({
    resumo: falhas.length ? `${falhas.length} FALHA(S)` : (atencoes.length ? 'ok, com pontos de atenção' : 'tudo ok'),
    verificadoEm: agoraBrasil(),
    falhas: falhas.map(f => f.nome),
    checagens
  });
});
// ══════════════════════════════════════════════════════════════
// ── ROTA: CORRIGIR OS CABEÇALHOS DA PLANILHA (rodar uma vez)
// ══════════════════════════════════════════════════════════════
// Escreve a linha 1 inteira com os nomes corretos. Corrige o typo TELEFONTE,
// limpa o "CIDADE São Paulo" que tinha valor grudado no titulo, nomeia a
// coluna J que o bot ja preenchia sem cabecalho, e cria K a N.
// Mexe SO na linha 1. Nenhum dado de lead e tocado.
app.get('/corrigir-cabecalhos', async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(500).json({ erro: 'sheets indisponivel' });
    const antes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:O1`
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:O1`,
      valueInputOption: 'RAW',
      requestBody: { values: [CABECALHO_PADRAO] }
    });
    const depois = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:O1`
    });
    console.log('Cabecalhos corrigidos na planilha de leads');
    res.json({
      status: 'cabecalhos atualizados',
      antes: antes.data.values ? antes.data.values[0] : [],
      depois: depois.data.values ? depois.data.values[0] : []
    });
  } catch(e) {
    res.status(500).json({ erro: e.message, dica: 'Confirme que a conta de servico esta como Editor na planilha.' });
  }
});
// ── ROTA: ENVIO MANUAL DE LEAD
app.post('/lead', async (req, res) => {
  const lead = req.body;
  // NAO_LEAD nunca aciona o comercial, nem por esta rota.
  if (isNaoLead(lead)) {
    console.log('POST /lead com NAO_LEAD, e-mail bloqueado:', lead.nome, lead.empresa);
    return res.json({ success: true, emailEnviado: false, motivo: 'NAO_LEAD, nao aciona o comercial' });
  }
  if (!validarLead(lead)) {
    return res.status(400).json({ error: 'Lead sem dados de contato suficientes' });
  }
  try {
    corrigirClassificacaoSeInconsistente(lead);
    await enviarEmailLead(lead);
    res.json({ success: true, emailEnviado: true, classificacao: lead.classificacao });
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
      range: `${SHEET_NAME}!A1:O1`
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
        range: `${SHEET_NAME}!A1:O1`
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
  // Segunda trava para NAO_LEAD. A primeira esta no webhook, esta aqui garante
  // que nenhum caminho novo de codigo acione o comercial por engano.
  if (isNaoLead(lead)) {
    console.log('EMAIL BLOQUEADO: NAO_LEAD nao aciona o comercial:', lead.nome, lead.empresa);
    return;
  }
  if (!validarLead(lead)) {
    console.log('EMAIL BLOQUEADO: lead sem contato suficiente:', lead.nome, lead.empresa);
    return;
  }
  const placar = placarCriterios(lead);
  const cor = v => v === 'OK' ? '#1B7F4B' : (v === 'FALHOU' ? '#C0392B' : '#888888');
  const linhaCriterio = (rotulo, chave, extra) => `
      <tr>
        <td><b>${rotulo}</b></td>
        <td style="color:${cor(placar.detalhe[chave])}"><b>${placar.detalhe[chave]}</b>${extra ? ` <span style="color:#555">(${extra})</span>` : ''}</td>
      </tr>`;
  const html = `
    <h2 style="color:#47166B">Novo Lead ${lead.classificacao || 'sem classificação'} — Ginger Agente</h2>
    <p style="font-size:16px"><b>Apuração dos critérios: ${placar.ok} de 4</b></p>
    ${numero ? `<p><b>Número WhatsApp:</b> ${numero}</p>` : ''}
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
      <tr style="background:#F2EAF7"><td colspan="2"><b>APURAÇÃO</b></td></tr>
      ${linhaCriterio('CNPJ confirmado', 'criterio_cnpj', lead.cnpj)}
      ${linhaCriterio('Interesse em abrir projeto', 'criterio_projeto', '')}
      ${linhaCriterio('Volume mínimo', 'criterio_volume', lead.volume_mensal)}
      ${linhaCriterio('Segmento atendido', 'criterio_segmento', lead.segmento)}
      <tr><td><b>Classificação</b></td><td><b>${lead.classificacao || '-'}</b></td></tr>
      <tr><td><b>Motivo</b></td><td>${lead.motivo_classificacao || '-'}</td></tr>
      <tr style="background:#F2EAF7"><td colspan="2"><b>DADOS DO CONTATO</b></td></tr>
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
    </table>
    <p style="color:#47166B;font-size:13px"><b>Ao abrir o projeto no Otimizah, anote o número do projeto na coluna PROJETO da planilha LEADS GINGER.</b> É o que permite medir o retorno dos leads da internet.</p>
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
        subject: `Lead ${lead.classificacao || 'BOM'} (${placar.ok}/4): ${lead.empresa || 'Sem empresa'} — Agente Ginger`,
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
// ── RENOVAÇÃO AUTOMÁTICA DO TOKEN DO INSTAGRAM (uma vez por dia)
setInterval(() => {
  rotinaTokenInstagram().catch(e => console.error('Rotina do token do Instagram falhou:', e.message));
}, 24 * 60 * 60 * 1000);
// ── INICIAR SERVIDOR
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor Ginger rodando na porta ${PORT}`);
  console.log('Canal: WhatsApp Cloud API (Meta)');
  console.log('Versao: sessao 22, regua de qualificacao corrigida');
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
  console.log('Corrigir cabecalhos da planilha: GET /corrigir-cabecalhos');
  console.log('Metricas dos leads da internet: GET /metricas?mes=8&ano=2026');
  console.log('Inbox de auditoria: GET /inbox?chave=... ' + (process.env.INBOX_KEY ? '(INBOX_KEY configurada)' : '(FALTA criar INBOX_KEY no Render)'));
  console.log('Painel analitico: GET /painel?chave=...&mes=8&ano=2026');
  console.log('Instagram: webhook em /instagram · teste em GET /instagram-test?chave=... ' +
    (IG_TOKEN && IG_USER_ID ? '(configurado, host ' + IG_BASE + ')' : '(FALTAM INSTAGRAM_TOKEN e INSTAGRAM_USER_ID)'));
  console.log('Messenger: webhook em /facebook · teste em GET /facebook-test?chave=... ' +
    (FB_TOKEN && FB_PAGE_ID ? '(configurado, host ' + FB_BASE + ')' : '(FALTAM FACEBOOK_PAGE_TOKEN e FACEBOOK_PAGE_ID)'));
  console.log('Situacao do token do Instagram: GET /instagram-status?chave=...');
  console.log('Saude geral do sistema: GET /saude?chave=...');
  console.log('Ativar o numero: GET /phone-register');
  console.log('Ver vinculo do webhook: GET /webhook-status');
  console.log('Criar vinculo do webhook: GET /webhook-subscribe');
  if (!WA_TOKEN || !WA_PHONE_ID || !WA_VERIFY_TOKEN) {
    console.warn('⚠️ Faltam variáveis da Cloud API. Configure WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_VERIFY_TOKEN no Render.');
  }
  if (REDIS_URL) {
    const teste = await redis('PING');
    console.log('Redis PING:', teste === 'PONG' ? 'CONECTADO' : 'FALHOU');
    // Registra desde quando conhecemos o token, sem renovar: a Meta exige que
    // o token tenha mais de 24h de vida para aceitar uma renovacao.
    await semearTokenInstagram();
  }
});
