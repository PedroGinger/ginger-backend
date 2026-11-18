// ══════════════════════════════════════════════════════════════
// ── MINDSTRACT CRM — ENVIO DO LEAD QUALIFICADO
// ══════════════════════════════════════════════════════════════
// Antes disto, o lead qualificado parava na planilha e no e-mail, e alguem
// tinha que cadastrar no CRM na mao. Quem esquecia, perdia o lead, e nao
// existia como medir quantos leads qualificados viraram projeto.
//
// ⚠️ POR QUE O CNPJ NAO E ENVIADO ⚠️
// O POST /clients do Mindstract e upsert, e a ordem de busca e telefone,
// depois CPF/CNPJ, depois e-mail. Mandar o CNPJ faria o segundo contato de
// uma empresa SOBRESCREVER o primeiro: a Priscila do P&D viraria a Amanda de
// Compras na mesma ficha. Como a Ginger e B2B e fala com varias pessoas da
// mesma empresa, o CNPJ fica de fora e o telefone e a identidade do contato.
// O nome da empresa viaja em "company", entao o vinculo nao se perde.
//
// Falha aqui nunca derruba o fluxo do lead. A planilha e o e-mail continuam
// sendo a fonte da verdade; o CRM e destino adicional.
const MINDSTRACT_API_URL = process.env.MINDSTRACT_API_URL || 'https://apiv2.mindstract.com.br/api/v1';
const MINDSTRACT_API_KEY = process.env.MINDSTRACT_API_KEY || '';
// Liga e desliga sem deploy. Deixe "0" para testar o resto sem tocar no CRM.
const MINDSTRACT_ATIVO = String(process.env.MINDSTRACT_ATIVO || '1') !== '0';
// So estas classificacoes viram contato no CRM. RUIM, NAO_LEAD, POS_VENDA e
// DUVIDA_TECNICA ficam de fora para a base nao encher de quem nao e lead e o
// numero de conversao continuar honesto.
const CRM_CLASSIFICACOES = ['BOM', 'POTENCIAL_FUTURO'];

function crmTelefoneE164(valor) {
  const bruto = String(valor || '').trim();
  // O IGSID do Instagram ("ig:178...") e a chave do Facebook nao sao telefone.
  // Sem esta guarda eles virariam "+178..." e o CRM ganharia um numero que nao
  // existe, exatamente o que telefoneDoLead evita no resto do sistema.
  if (!/^[\d\s()+-]+$/.test(bruto)) return '';
  const d = bruto.replace(/\D/g, '');
  // O "+" e decisivo e vem primeiro: "+1 415 555 2671" tem 11 digitos e cairia
  // na regra brasileira, virando um numero de Campinas que nao existe.
  if (bruto.startsWith('+')) return (d.length >= 11 && d.length <= 15) ? '+' + d : '';
  if (d.length === 10 || d.length === 11) return '+55' + d;        // BR sem DDI
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return '+' + d;
  return '';
}

function crmTagDoCanal(origem) {
  const o = String(origem || '').toLowerCase();
  if (o.includes('instagram') || o.startsWith('ig')) return 'instagram';
  if (o.includes('facebook') || o.startsWith('fb')) return 'facebook';
  if (o.includes('site')) return 'site';
  if (o.includes('whats') || o.includes('planilha')) return 'whatsapp';
  return 'agente';
}

function crmTags(lead, ctx, placar) {
  const t = ['lead do agente', crmTagDoCanal(ctx && ctx.origem)];
  const classe = String(lead.classificacao || '').trim().toUpperCase();
  if (classe === 'BOM') t.push('lead qualificado');
  if (classe === 'POTENCIAL_FUTURO') t.push('potencial futuro');
  t.push(ehMateriaPrima(lead) ? 'matéria-prima' : 'fragrância');
  if (placar && placar.informados === 4) t.push(`critérios ${placar.ok}/4`);
  if (lead.dadosIncompletos && lead.dadosIncompletos.length) t.push('dados incompletos');
  if (lead.promessaDeEspecialistaPendente) t.push('promessa em aberto');
  if (lead.cobrandoRetorno) t.push('cobrando retorno');
  return [...new Set(t.filter(Boolean))];
}

function crmNotas(lead, placar) {
  const l = [];
  if (lead.motivo_classificacao) l.push(lead.motivo_classificacao);
  if (placar && placar.detalhe) {
    l.push(`Critérios: CNPJ ${placar.detalhe.criterio_cnpj}, projeto ${placar.detalhe.criterio_projeto}, ` +
           `volume ${placar.detalhe.criterio_volume}, segmento ${placar.detalhe.criterio_segmento}`);
  }
  if (lead.segmento) l.push(`Segmento: ${lead.segmento}`);
  if (lead.volume_mensal) l.push(`Volume mensal declarado: ${lead.volume_mensal}`);
  if (lead.fornecedor_atual) l.push(`Fornecedor atual: ${lead.fornecedor_atual}`);
  if (lead.funcionarios) l.push(`Funcionários: ${lead.funcionarios}`);
  if (lead.projeto) l.push(`Projeto: ${lead.projeto}`);
  if (lead.cnpj) l.push(`CNPJ informado na conversa: ${lead.cnpj}`);
  return l.join('\n');
}

async function enviarLeadParaCRM(lead, ctx, placar) {
  if (!MINDSTRACT_ATIVO) return null;
  if (!MINDSTRACT_API_KEY) {
    console.log('CRM ignorado: MINDSTRACT_API_KEY não configurada.');
    return null;
  }
  const classe = String(lead && lead.classificacao || '').trim().toUpperCase();
  if (!CRM_CLASSIFICACOES.includes(classe)) return null;

  const telefone = crmTelefoneE164(lead.telefone);
  const email = String(lead.email || '').trim();
  if (!telefone && !email) {
    console.log('CRM ignorado: lead sem telefone e sem e-mail.', lead.nome);
    return null;
  }

  const corpo = {
    name: String(lead.nome || '').trim() || (lead.empresa ? String(lead.empresa).trim() : 'Contato sem nome'),
    company: String(lead.empresa || '').trim() || undefined,
    phone: telefone || undefined,
    email: email || undefined,
    tags: crmTags(lead, ctx, placar),
    notes: crmNotas(lead, placar) || undefined
    // cpf_cnpj fica de proposito de fora. Ver o comentario no topo da secao.
  };
  Object.keys(corpo).forEach(k => corpo[k] === undefined && delete corpo[k]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${MINDSTRACT_API_URL}/clients`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': MINDSTRACT_API_KEY
      },
      body: JSON.stringify(corpo),
      signal: controller.signal
    });
    const texto = await r.text();
    if (!r.ok) {
      console.log(`CRM ERRO ${r.status} para ${corpo.name}: ${texto.substring(0, 400)}`);
      return null;
    }
    let dados = {};
    try { dados = JSON.parse(texto); } catch (e) {}
    console.log(`CRM OK: ${corpo.name} ${dados.created === false ? 'atualizado' : 'criado'}` +
      `${dados.matched_by ? ` (casou por ${dados.matched_by})` : ''} | tags: ${corpo.tags.join(', ')}`);
    return dados;
  } catch (e) {
    // Timeout, rede fora, API fora. O lead ja esta na planilha e o e-mail ja
    // saiu, entao nada se perde: fica so sem a ficha no CRM.
    console.log(`CRM FALHOU para ${corpo.name}: ${e.name === 'AbortError' ? 'timeout de 10s' : e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
