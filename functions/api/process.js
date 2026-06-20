// functions/api/process.js
//
// Caminho de RESERVA. Só é chamado quando o navegador não suporta
// reconhecimento de voz nativo (ex.: Firefox) ou quando a transcrição ao
// vivo veio vazia/curta demais. Na maioria dos casos (Chrome/Edge), o app
// usa /api/structure, que é gratuito do lado da transcrição.
//
// Fluxo:
//   1. Recebe o áudio gravado no navegador (multipart/form-data, campo "audio").
//   2. Envia para a Groq (Whisper) para transcrição em português.
//   3. Envia a transcrição para um modelo da Groq, pedindo a resposta em JSON
//      já estruturada nos 4 campos do registro.
//   4. Devolve { transcript, soap: {queixaHda, exameFisico, hipoteseDiagnostica, conduta}, soap_raw }.
//
// A chave da API (GROQ_API_KEY) nunca é exposta ao navegador: ela só existe
// nas variáveis de ambiente da função, configuradas no painel da Cloudflare.

const TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
const CHAT_MODEL = 'llama-3.1-8b-instant';

const SYSTEM_PROMPT = `Você é um assistente de documentação médica de pronto-socorro/emergência. Você recebe a transcrição bruta de um atendimento (fala natural, podendo ter trechos truncados ou ambíguos) e deve organizá-la em um registro clínico objetivo, em português, no padrão usado em emergência.

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

  let audioFile;
  try {
    const formData = await request.formData();
    audioFile = formData.get('audio');
  } catch (err) {
    return jsonResponse({ error: 'Não foi possível ler o áudio enviado.' }, 400);
  }

  if (!audioFile || typeof audioFile === 'string') {
    return jsonResponse({ error: 'Nenhum arquivo de áudio recebido.' }, 400);
  }

  // 1. Transcrição
  let transcript;
  try {
    const transcriptionForm = new FormData();
    transcriptionForm.append('file', audioFile, audioFile.name || 'gravacao.webm');
    transcriptionForm.append('model', TRANSCRIPTION_MODEL);
    transcriptionForm.append('language', 'pt');
    transcriptionForm.append('response_format', 'json');

    const transcriptionRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
      body: transcriptionForm
    });

    if (!transcriptionRes.ok) {
      const details = await safeText(transcriptionRes);
      return jsonResponse({ error: 'Falha na transcrição do áudio.', details }, 502);
    }

    const transcriptionData = await transcriptionRes.json();
    transcript = (transcriptionData.text || '').trim();

    if (!transcript) {
      return jsonResponse({ error: 'A transcrição voltou vazia. Tente gravar novamente, falando mais perto do microfone.' }, 422);
    }
  } catch (err) {
    return jsonResponse({ error: 'Erro de rede ao transcrever o áudio.', details: String(err) }, 502);
  }

  // 2. Estruturação em SOAP
  let soap = null;
  let soapRaw = '';
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
          { role: 'user', content: `Transcrição da consulta:\n\n${transcript}` }
        ]
      })
    });

    if (!chatRes.ok) {
      const details = await safeText(chatRes);
      return jsonResponse({ error: 'Falha ao gerar o registro SOAP.', details, transcript }, 502);
    }

    const chatData = await chatRes.json();
    soapRaw = chatData.choices?.[0]?.message?.content || '';

    try {
      soap = JSON.parse(soapRaw);
    } catch (parseErr) {
      soap = null; // o front-end usa soap_raw como reserva neste caso
    }
  } catch (err) {
    return jsonResponse({ error: 'Erro de rede ao gerar o registro SOAP.', details: String(err), transcript }, 502);
  }

  return jsonResponse({ transcript, soap, soap_raw: soapRaw }, 200);
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
