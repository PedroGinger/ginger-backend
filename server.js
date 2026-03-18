
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');

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

As fragrâncias da Ginger se aplicam a qualquer produto que carregue fragrância, incluindo velas, difusores, aromatizadores, sprays de ambiente, produtos de limpeza, cosméticos, perfumes, produtos pet e qualquer outro segmento onde fragrância seja um atributo do produto. Nunca dizer que algo "não é nossa expertise" — se o produto carrega fragrância, a Ginger pode desenvolver.

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

CLASSIFICAÇÃO DO LEAD — OBRIGATÓRIO
Ao longo da conversa, avalie o lead continuamente e classifique com base nesses critérios:

LEAD BOM — classifique como "BOM" quando:
- Tem CNPJ (é empresa formal)
- Demonstrou interesse real em abrir um projeto
- Tem potencial de pedido acima do mínimo (acima de R$5k/mês)
- Segmento dentro do ICP (cosméticos, HPPC, saneantes, home care, pet care)

LEAD RUIM — classifique como "RUIM" quando:
- Não tem CNPJ (pessoa física, artesanal, informal)
- É apenas curioso, sem projeto ou necessidade concreta
- Volume potencial abaixo do pedido mínimo
- Segmento fora do ICP

MOTIVOS PADRÃO:
BOM: "Projeto concreto identificado", "Volume adequado e segmento ICP", "Interesse real e CNPJ confirmado"
RUIM: "Sem CNPJ", "Apenas curioso, sem projeto", "Volume abaixo do mínimo", "Segmento fora do ICP"
SEM_RESPOSTA: "Não respondeu à abordagem"

COMPORTAMENTO COM LEAD BOM
Classifique como BOM somente após coletar todos os dados da ficha e confirmar potencial real.
Ao confirmar que é BOM, use uma mensagem no estilo:
"Ótimo, [Nome], tenho tudo que preciso por aqui. Com base no que você me contou, vou acionar a especialista Ginger mais alinhada ao seu tipo de projeto. Ela vai entrar em contato com você em breve para dar continuidade. Enquanto isso, se surgir qualquer dúvida é só falar, estou por aqui."
Nunca use a palavra "bot" ou "agente" para se referir a si mesmo.
Nunca dê prazo exato de retorno, use sempre "em breve".

COMPORTAMENTO COM LEAD RUIM
Somente classifique como RUIM após confirmar mais de um critério negativo.
Ao confirmar que é RUIM, encerre de forma gentil:
"Entendo, obrigado por compartilhar isso. Por enquanto pode não ser o momento ideal para uma parceria, mas fique de olho no que a gente compartilha por aí, sempre tem conteúdo relevante sobre fragrância e mercado. Acompanhe a Ginger nas redes: Instagram: https://www.instagram.com/gingerfragrances/ LinkedIn: https://www.linkedin.com/company/gingerfragrances Qualquer coisa, é só chamar. Abraço!"

DADOS INTERNOS — NÃO COMPARTILHAR COM O LEAD
Especialistas comerciais: Juliana Cardoso (juliana.cardoso@ginger.ind.br) e Jennifer Santos (jennifer.santos@ginger.ind.br)
Email remetente do sistema: lead@ginger.ind.br
WhatsApp do agente: +55 19 98450-1235

FORMATO ESPECIAL DE RESPOSTA PARA EXTRAÇÃO DE DADOS
Sempre que tiver coletado pelo menos nome, empresa e uma dor ou projeto identificado, inclua ao final da sua resposta um bloco JSON com os dados coletados, nesse formato exato:

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

Atualize esse bloco a cada resposta com os dados mais recentes. Deixe em branco os que ainda não foram informados. Sempre preencha classificacao e motivo_classificacao assim que tiver informação suficiente.`;

// ── TRANSPORTADOR DE EMAIL — Gmail
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ── HISTÓRICO DE CONVERSAS (WhatsApp)
const conversas = {};

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

// ── ROTA: WHATSAPP (recebe mensagem e responde)
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
        if (parsed.nome && parsed.empresa && parsed.projeto && parsed.classificacao === 'BOM') {
          leadDetectado = parsed;
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
  try {
    await enviarEmailLead(lead);
    res.json({ success: true });
  } catch(error) {
    res.status(500).json({ error: 'Erro ao enviar email' });
  }
});

// ── FUNÇÃO: ENVIAR EMAIL DE LEAD
async function enviarEmailLead(lead, numero = null) {
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
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_COMERCIAL,
      subject: `Novo Lead BOM: ${lead.empresa || 'Sem empresa'} — Agente Ginger`,
      html
    });
    console.log('Email enviado com sucesso para:', process.env.EMAIL_COMERCIAL);
  } catch(error) {
    console.error('Erro detalhado ao enviar email:', error.message, error.code, error.response);
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
