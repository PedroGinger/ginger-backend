const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(cors({
  origin: ['https://ginger.ind.br', 'https://www.ginger.ind.br']
}));

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

TOM DE VOZ
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
SEMPRE manter cordialidade e educação, independente do tom do interlocutor. Se o contato for grosseiro, agressivo ou mal educado, o agente nunca rebate, nunca eleva o tom e nunca demonstra irritação. Responde com calma, respeito e gentileza, redirecionando a conversa de forma natural. A Ginger nunca perde a compostura, em nenhuma circunstância.
NUNCA revelar informações sigilosas ou internas da Ginger, incluindo faturamento, margens, políticas internas, nomes de fornecedores, fórmulas, estrutura de custos, dados de clientes, salários ou qualquer informação estratégica confidencial. Se pressionado, responder com cordialidade que essas informações são restritas e não podem ser compartilhadas.
Em algum momento natural da conversa, especialmente com clientes menores ou que demonstrem insegurança sobre volume, transmita de forma sucinta que na Ginger cada kg importa. Não use essa frase literalmente, mas transmita essa essência, que a Ginger se dedica ao projeto do cliente independente do tamanho do pedido. Nunca force esse momento, ele deve surgir naturalmente no contexto da conversa.

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
- Paris Essências (loja física e online), fracionado de 1kg e 100ml
- Marco Aurelio (loja física), fracionado de 1kg
- Wanny (loja física e online), fracionado de 1kg e 100ml
- Paraiso das Essências (loja física e online), fracionado de 1kg

Estado de Pernambuco:
- La Bela Essenza (loja física), fracionado de 1kg

Estado do Amazonas:
- Aromas do Norte (loja física), fracionado de 100ml

Se o contato não informar o estado, mencionar as revendas online disponíveis (Paris Essências e Wanny).

COMPORTAMENTO COM LEAD POTENCIAL FUTURO
Ao identificar como POTENCIAL_FUTURO, encerrar de forma gentil e direcionar para as revendas:
"Entendo, [Nome]! Para o seu momento atual, a melhor opção é comprar através de uma das nossas revendas parceiras, onde você consegue adquirir em volumes menores. [mencionar as revendas do estado do contato]. Quando seu volume crescer, adoraríamos ter você como cliente direto da Ginger. Qualquer dúvida, estou por aqui!"

RITMO DA CONVERSA — REGRA CRÍTICA
Adapte o tamanho e ritmo das respostas ao comportamento do lead. Isso é uma das regras mais importantes do agente.

MODO RÁPIDO (lead com pressa ou que já sabe o que quer):
Quando o lead demonstrar pressa, querer fechar rápido, já tiver uma fragrância ou quantidade em mente, ou simplesmente não quiser conversar muito, o agente DEVE ser direto e curto. Respostas de no máximo 2 a 3 linhas. Sem explicações longas, sem perguntas abertas, sem apresentar o método ou a empresa. Apenas coletar as informações cruciais para o comercial: Nome, Empresa, CNPJ, Email, Telefone e quantidade desejada. Assim que tiver esses 6 dados, classificar como BOM e enviar. Não insistir em mais informações.

MODO COMPLETO (lead tranquilo e receptivo):
Quando o lead estiver respondendo com calma e detalhando seu projeto, seguir com o briefing completo normalmente, coletando todos os 11 campos e entendendo a dor antes de encerrar.

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
WhatsApp do agente: +55 19 98354-0110

FORMATO ESPECIAL DE RESPOSTA PARA EXTRAÇÃO DE DADOS
Sempre que tiver coletado pelo menos nome, empresa, CONTATO (email ou telefone) e uma dor ou projeto identificado, inclua ao final da sua resposta um bloco JSON com os dados coletados, nesse formato exato:

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

// ── HISTÓRICO DE CONVERSAS (WhatsApp)
const conversas = {};

// ── FUNÇÃO: VALIDAR LEAD ANTES DE ENVIAR EMAIL
function validarLead(parsed) {
  if (!parsed.nome || !parsed.nome.trim()) return false;
  if (!parsed.empresa || !parsed.empresa.trim()) return false;
  const temEmail = parsed.email && parsed.email.trim() && parsed.email.trim() !== '-';
  const temTelefone = parsed.telefone && parsed.telefone.trim() && parsed.telefone.trim() !== '-';
  if (!temEmail && !temTelefone) return false;
  return true;
}

// ── ROTA: HEALTH CHECK
app.get('/', (req, res) => {
  res.json({ status: 'Servidor Ginger online' });
});

// ── ROTA: CHAT DO SITE
app.post('/chat', async (req, res) => {
  const { messages } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ── ROTA: WHATSAPP Z-API (recebe mensagem e responde)
app.post('/whatsapp-zapi', async (req, res) => {
  console.log('WEBHOOK RECEBIDO:', JSON.stringify(req.body).substring(0, 500));
  res.status(200).json({ ok: true });

  try {
    const body = req.body;
    if (body.fromMe) return;

    const numero = body.phone;
    const mensagem = body.text?.message || body.text;

    if (!numero || !mensagem || typeof mensagem !== 'string' || !mensagem.trim()) {
      console.log('Mensagem ignorada: sem numero ou texto valido');
      return;
    }

    console.log('Processando mensagem de:', numero, 'Texto:', mensagem.substring(0, 100));

    if (!conversas[numero]) {
      conversas[numero] = [];
      conversas[numero].lastActivity = Date.now();
    }

    conversas[numero].push({ role: 'user', content: mensagem });
    conversas[numero].lastActivity = Date.now();
    if (conversas[numero].length > 20) {
      conversas[numero] = conversas[numero].slice(-20);
      conversas[numero].lastActivity = Date.now();
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: conversas[numero].filter(m => m.role && m.content)
      })
    });

    const data = await response.json();
    const raw = data.content?.[0]?.text || 'Não consegui processar. Pode repetir?';

    console.log('Resposta gerada para:', numero);

    const regex = /%%%LEAD_DATA%%%([\s\S]*?)%%%END_LEAD_DATA%%%/;
    const match = raw.match(regex);
    let leadDetectado = null;

    if (match) {
      try {
        const parsed = JSON.parse(match[1].trim());

        // AUTO-FILL: se veio pelo WhatsApp e não tem telefone, preenche com o número
        if (!parsed.telefone || !parsed.telefone.trim() || parsed.telefone.trim() === '-') {
          parsed.telefone = numero;
          console.log('Telefone auto-preenchido com número WhatsApp:', numero);
        }

        // VALIDAÇÃO: só envia email se tiver nome + empresa + contato
        if (validarLead(parsed)) {
          leadDetectado = parsed;
          console.log('Lead VALIDADO:', parsed.nome, parsed.empresa, 'Classificação:', parsed.classificacao);
        } else {
          console.log('Lead BLOQUEADO (dados incompletos):', JSON.stringify(parsed));
        }
      } catch(e) {
        console.log('Erro ao parsear lead:', e.message);
      }
    }

    const resposta = raw.replace(regex, '').trim();
    conversas[numero].push({ role: 'assistant', content: raw });

    const ZAPI_ID = process.env.ZAPI_INSTANCE_ID;
    const ZAPI_TOKEN = process.env.ZAPI_TOKEN;

    console.log('Enviando resposta via Z-API para:', numero);

    const zapiResponse = await fetch(`https://api.z-api.io/instances/${ZAPI_ID}/token/${ZAPI_TOKEN}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN },
      body: JSON.stringify({
        phone: numero,
        message: resposta
      })
    });

    const zapiResult = await zapiResponse.json();
    console.log('Z-API resposta:', JSON.stringify(zapiResult));

    if (leadDetectado) {
      await enviarEmailLead(leadDetectado, numero);
    }
  } catch(error) {
    console.error('Erro WhatsApp Z-API:', error.message);
  }
});

// ── ROTA: WHATSAPP LEGADO (manter compatibilidade)
app.post('/whatsapp', async (req, res) => {
  const { numero, mensagem } = req.body;

  if (!conversas[numero]) {
    conversas[numero] = [];
    conversas[numero].push({
      role: 'assistant',
      content: 'Olá! Tudo bem?\n\nSou da equipe Ginger. Pode falar à vontade, seja sobre um produto que você quer lançar, uma linha que precisa de ajuste, ou só uma dúvida sobre como a gente trabalha.\n\nO que te trouxe até aqui?'
    });
  }

  conversas[numero].push({ role: 'user', content: mensagem });
  if (conversas[numero].length > 20) {
    conversas[numero] = conversas[numero].slice(-20);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: conversas[numero]
      })
    });

    const data = await response.json();
    const raw = data.content?.[0]?.text || 'Não consegui processar. Pode repetir?';

    const regex = /%%%LEAD_DATA%%%([\s\S]*?)%%%END_LEAD_DATA%%%/;
    const match = raw.match(regex);
    let leadDetectado = null;

    if (match) {
      try {
        const parsed = JSON.parse(match[1].trim());

        // VALIDAÇÃO: só envia email se tiver nome + empresa + contato
        if (validarLead(parsed)) {
          leadDetectado = parsed;
        } else {
          console.log('Lead BLOQUEADO no chat (dados incompletos):', JSON.stringify(parsed));
        }
      } catch(e) {}
    }

    const resposta = raw.replace(regex, '').trim();
    conversas[numero].push({ role: 'assistant', content: raw });

    if (leadDetectado) {
      await enviarEmailLead(leadDetectado, numero);
    }

    res.json({ resposta });
  } catch(error) {
    res.status(500).json({ resposta: 'Erro interno. Tente novamente.' });
  }
});

// ── ROTA: ABORDAGEM PROATIVA (landing page)
app.post('/abordar', async (req, res) => {
  const { numero, nome, empresa, cidade, faturamento } = req.body;
  const primeiroNome = nome.split(' ')[0];

  const mensagemInicial = `Olá, ${primeiroNome}! Tudo bem?\n\nVi que você demonstrou interesse em conhecer melhor a Ginger. Fico feliz em ter você aqui.\n\nSou da equipe Ginger Fragrance Design. A gente desenvolve fragrâncias estratégicas para indústrias como a ${empresa}, ajudando marcas a se diferenciarem com identidade olfativa própria.\n\nPosso entender melhor o que vocês estão buscando?`;

  conversas[numero] = [
    {
      role: 'user',
      content: `[CONTEXTO INTERNO — não mencionar ao lead]\nLead qualificado da landing page:\nNome: ${nome}\nEmpresa: ${empresa}\nCidade: ${cidade}\nFaturamento: ${faturamento}\n\nUse essas informações para personalizar a conversa. Já enviamos a mensagem de abertura abaixo. Aguarde a resposta do lead para continuar.`
    },
    { role: 'assistant', content: mensagemInicial }
  ];

  res.json({ numero, mensagem: mensagemInicial });
});

// ── ROTA: ENVIO MANUAL DE LEAD (site)
app.post('/lead', async (req, res) => {
  const lead = req.body;

  // VALIDAÇÃO: mesmo para envio manual, exigir contato
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

// ── FUNÇÃO: ENVIAR EMAIL DE LEAD via Resend
async function enviarEmailLead(lead, numero = null) {
  // TRAVA FINAL: nunca enviar email sem contato
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

// ── LIMPEZA DE HISTÓRICO INATIVO (a cada 2h)
setInterval(() => {
  const limite = Date.now() - (2 * 60 * 60 * 1000);
  Object.keys(conversas).forEach(num => {
    if (conversas[num].lastActivity < limite) delete conversas[num];
  });
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Ginger rodando na porta ${PORT}`));
