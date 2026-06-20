// functions/api/structure.js
//
// Caminho padrão e barato do app. Recebe só o TEXTO já transcrito pelo
// reconhecimento de voz do navegador (gratuito, local) e pede pra IA
// organizar nos 4 campos do registro clínico. Nenhum áudio passa por aqui —
// é por isso que esse caminho é o mais barato e o mais privado.
//
// Usa um modelo bem menor que o do /api/process (que só entra como reserva,
// quando o navegador não suporta reconhecimento de voz). Para uma tarefa de
// extrair e reorganizar informação que já está no texto, um modelo pequeno
// tende a ser suficiente — vale validar a qualidade com transcrições reais
// antes de confiar de olhos fechados.

const CHAT_MODEL = 'llama-3.1-8b-instant';

const SYSTEM_PROMPT = `Você é um assistente de documentação médica de pronto-socorro/emergência. Você recebe a transcrição de um atendimento (fala natural, podendo ter trechos truncados ou ambíguos) e deve organizá-la em um registro clínico objetivo, em português, no padrão usado em emergência.

Regras obrigatórias:
- Use apenas informações presentes na transcrição. Nunca invente sintomas, achados, diagnósticos ou condutas que não foram mencionados.
- Se uma seção não tiver informação suficiente na transcrição, escreva exatamente: "Não relatado nesta consulta."
- Seja conciso e objetivo, como um médico escreveria em prontuário de emergência — frases curtas, sem floreios. A queixa principal/HDA deve ser especialmente enxuta.
- Responda APENAS com um objeto JSON válido, sem nenhum texto antes ou depois, no formato exato:
{"queixaHda": "...", "exameFisico": "...", "hipoteseDiagnostica": "...", "conduta": "..."}

Onde:
- queixaHda: queixa principal e história da doença atual (sintomas, início, evolução, fatores associados).
- exameFisico: achados de exame físico, sinais vitais, resultados de exames mencionados.
- hipoteseDiagnostica: hipóteses diagnósticas, impressão clínica.
- conduta: conduta tomada, prescrições, exames solicitados, orientações, encaminhamento ou alta.`;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.GROQ_API_KEY) {
    return jsonResponse({ error: 'GROQ_API_KEY não configurada no ambiente da função.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'JSON inválido.' }, 400);
  }

  const text = (body.text || '').trim();
  if (!text) return jsonResponse({ error: 'Texto vazio.' }, 400);

  try {
    const chatRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text }
        ]
      })
    });

    if (!chatRes.ok) {
      const details = await safeText(chatRes);
      return jsonResponse({ error: 'Falha ao organizar o registro.', details }, 502);
    }

    const data = await chatRes.json();
    const soapRaw = data.choices?.[0]?.message?.content || '';
    let soap = null;
    try {
      soap = JSON.parse(soapRaw);
    } catch (e) {
      soap = null;
    }

    return jsonResponse({ soap, soap_raw: soapRaw }, 200);
  } catch (err) {
    return jsonResponse({ error: 'Erro de rede ao organizar o registro.', details: String(err) }, 502);
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
