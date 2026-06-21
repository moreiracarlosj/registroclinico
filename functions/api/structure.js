// functions/api/structure.js
//
// Caminho padrão e barato do app. Recebe só o TEXTO já transcrito pelo
// reconhecimento de voz do navegador (gratuito, local) e o MODELO escolhido
// pelo médico (Adulto/Criança/Gestante, editável no app) e pede pra IA
// preencher o modelo com base na transcrição. Nenhum áudio passa por aqui —
// é por isso que esse caminho é o mais barato e o mais privado.
//
// Usa um modelo bem menor que o do /api/process (que só entra como reserva,
// quando o navegador não suporta reconhecimento de voz). Para uma tarefa de
// preencher um texto-padrão com informação que já está na transcrição, um
// modelo pequeno tende a ser suficiente — vale validar a qualidade com
// transcrições reais antes de confiar de olhos fechados.

const CHAT_MODEL = 'llama-3.1-8b-instant';

const SYSTEM_PROMPT = `Você é um assistente de documentação médica de pronto-socorro/emergência. Você recebe um MODELO de registro clínico (texto-padrão com estrutura fixa, frases de achados normais já escritas, e marcadores de preenchimento como "xxxx", "????", campos em branco ou rótulos seguidos de dois-pontos) e a TRANSCRIÇÃO de um atendimento real.

Sua tarefa: preencher o modelo com as informações da transcrição, devolvendo o texto completo do modelo já preenchido.

Regras obrigatórias:
- Mantenha a estrutura, a ordem das seções e a redação padrão do modelo o máximo possível.
- Substitua marcadores de preenchimento (xxxx, ????, campos em branco, valores genéricos) pelas informações reais ditas na transcrição.
- Frases de achados normais já escritas no modelo (ex.: "Sem sinais de desconforto respiratório", "RCR em 2T com BNF") devem ser MANTIDAS exatamente como estão, a menos que a transcrição diga explicitamente algo diferente — nesse caso, substitua pela informação real relatada.
- Nunca invente informações que não estejam na transcrição nem façam parte do texto padrão do modelo.
- Se uma informação pedida pelo modelo (ex.: peso, idade gestacional, hipótese diagnóstica, conduta) não foi mencionada na transcrição, deixe o campo correspondente em branco — não invente um valor.
- Preserve as quebras de linha do modelo.
- Responda APENAS com o texto final preenchido. Não inclua comentários, explicações, aspas ao redor do texto, ou qualquer marcação adicional (sem JSON, sem markdown).`;

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
  const template = (body.template || '').trim();
  if (!text) return jsonResponse({ error: 'Texto vazio.' }, 400);
  if (!template) return jsonResponse({ error: 'Modelo vazio.' }, 400);

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
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `MODELO:\n${template}\n\nTRANSCRIÇÃO:\n${text}` }
        ]
      })
    });

    if (!chatRes.ok) {
      const details = await safeText(chatRes);
      return jsonResponse({ error: 'Falha ao organizar o registro.', details }, 502);
    }

    const data = await chatRes.json();
    const registro = (data.choices?.[0]?.message?.content || '').trim();

    return jsonResponse({ registro }, 200);
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
