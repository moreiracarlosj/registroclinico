// functions/api/process.js
//
// Caminho de RESERVA. Só é chamado quando o navegador não suporta
// reconhecimento de voz nativo (ex.: Firefox) ou quando a transcrição ao
// vivo veio vazia/curta demais. Na maioria dos casos (Chrome/Edge), o app
// usa /api/structure, que é gratuito do lado da transcrição.
//
// Fluxo:
//   1. Recebe o áudio gravado no navegador e o MODELO escolhido pelo médico
//      (multipart/form-data, campos "audio" e "template").
//   2. Envia o áudio para a Groq (Whisper) para transcrição em português.
//   3. Envia a transcrição + o modelo para um modelo da Groq, pedindo o
//      modelo preenchido de volta como texto puro.
//   4. Devolve { transcript, registro }.
//
// A chave da API (GROQ_API_KEY) nunca é exposta ao navegador: ela só existe
// nas variáveis de ambiente da função, configuradas no painel da Cloudflare.

const TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
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

  let audioFile, template;
  try {
    const formData = await request.formData();
    audioFile = formData.get('audio');
    template = (formData.get('template') || '').toString().trim();
  } catch (err) {
    return jsonResponse({ error: 'Não foi possível ler o áudio enviado.' }, 400);
  }

  if (!audioFile || typeof audioFile === 'string') {
    return jsonResponse({ error: 'Nenhum arquivo de áudio recebido.' }, 400);
  }
  if (!template) {
    return jsonResponse({ error: 'Modelo vazio.' }, 400);
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

  // 2. Preenchimento do modelo
  let registro = '';
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
          { role: 'user', content: `MODELO:\n${template}\n\nTRANSCRIÇÃO:\n${transcript}` }
        ]
      })
    });

    if (!chatRes.ok) {
      const details = await safeText(chatRes);
      return jsonResponse({ error: 'Falha ao gerar o registro.', details, transcript }, 502);
    }

    const chatData = await chatRes.json();
    registro = (chatData.choices?.[0]?.message?.content || '').trim();
  } catch (err) {
    return jsonResponse({ error: 'Erro de rede ao gerar o registro.', details: String(err), transcript }, 502);
  }

  return jsonResponse({ transcript, registro }, 200);
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
