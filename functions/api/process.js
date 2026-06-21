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

const SYSTEM_PROMPT = `Você é um assistente de documentação médica de pronto-socorro/emergência. Você recebe um MODELO de registro clínico (texto-padrão com estrutura fixa, achados normais pré-escritos, e marcadores de preenchimento como "xxxx", "????", campos em branco ou rótulos seguidos de dois-pontos) e a TRANSCRIÇÃO de um atendimento real. Use o modelo como guia para preencher os espaços do que NÃO foi dito — não como uma redação livre.

GLOSSÁRIO (use para interpretar corretamente as siglas do modelo — isto não são valores a preencher):
BEG = bom estado geral. LOTE = lúcido, orientado em tempo e espaço. AR = aparelho respiratório. MV = murmúrio vesicular. AHT = ambos hemitórax. S/RA = sem ruídos adventícios. ACV = aparelho cardiovascular. RCR em 2T = ritmo cardíaco regular em dois tempos (sem terceiro/quarto tempo). BNF = bulhas normofonéticas. ABD = abdômen. OTO = otoscopia. OROF = orofaringe. vmg = visceromegalias. GPA = gestações/partos/abortos. IG = idade gestacional. DUM = data da última menstruação. TS = tipagem sanguínea. LA = líquido amniótico. BCF = batimentos cardíacos fetais. DU = dinâmica uterina. TV = toque vaginal.

REGRAS OBRIGATÓRIAS, NESTA ORDEM DE PRIORIDADE:

1. NÚMEROS E VALORES MENSURÁVEIS (frequência cardíaca, frequência respiratória, peso, pressão arterial, temperatura, idade gestacional, saturação, e qualquer outro valor numérico): NUNCA invente um número. Se a transcrição não disser esse valor explicitamente, deixe o marcador original (ex.: "xxxx", "????") ou o campo em branco, exatamente como estava no modelo. Um número errado num registro médico é mais perigoso que um campo vazio — isso vale mais que deixar o texto "completo".

2. ACHADOS NEGATIVOS/BOOLEANOS já escritos no modelo (ex.: "nega febre", "nega outros sintomas", "S/RA", "sem sopros", "DU ausente", "indolor à palpação", "nega alergias"): mantenha exatamente como estão por padrão — isso é o estado normal/esperado. Só troque pelo achado positivo se a transcrição afirmar EXPLICITAMENTE o contrário. "Não foi mencionado" não é o mesmo que "está presente" — na dúvida, mantenha a negação do modelo.

3. Texto livre (queixa, história, hipótese diagnóstica, conduta, orientações): preencha com o que foi efetivamente dito, de forma objetiva e concisa, no mesmo estilo do modelo.

4. COERÊNCIA FINAL: depois de preencher tudo, releia o registro inteiro antes de responder. Se uma informação mudou em um ponto (ex.: o paciente relatou febre), garanta que nenhum outro trecho do mesmo texto contradiga isso (ex.: não deixe "afebril" sem alteração em outro lugar do exame). O resultado deve ler como uma única descrição coerente do atendimento, não como frases preenchidas isoladamente.

5. Mantenha a estrutura, a ordem das seções e as quebras de linha do modelo. Nunca invente informação que não esteja na transcrição nem já fizesse parte do texto padrão do modelo.

Responda APENAS com o texto final preenchido. Não inclua comentários, explicações, aspas ao redor do texto, ou qualquer marcação adicional (sem JSON, sem markdown).`;

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
