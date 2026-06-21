// functions/api/relay.js
//
// Canal efêmero pra sincronizar o resultado gravado no celular com a tela
// do computador, quando os dois estão na mesma página pessoal (/seu-slug).
// Curta duração (expira sozinho em 10 min) e leitura única — depois que o
// computador lê um resultado "done", ele é apagado da KV.
//
// Isso é diferente de templates.js: aqui pode passar conteúdo real da
// consulta (texto/registro), só que de forma temporária — nunca fica salvo
// depois que é entregue, e expira sozinho mesmo que ninguém leia.

const RELAY_TTL_SECONDS = 600; // 10 minutos

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.APP_KV) return jsonResponse({ error: 'APP_KV não configurado no ambiente da função.' }, 500);

  const slug = sanitizeSlug(new URL(request.url).searchParams.get('slug'));
  if (!slug) return jsonResponse({ error: 'Slug inválido.' }, 400);

  const raw = await env.APP_KV.get(`relay:${slug}`);
  if (!raw) return jsonResponse({ status: 'empty' }, 200);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    payload = null;
  }
  if (!payload) return jsonResponse({ status: 'empty' }, 200);

  if (payload.status === 'done') {
    await env.APP_KV.delete(`relay:${slug}`); // leitura única
  }

  return jsonResponse(payload, 200);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.APP_KV) return jsonResponse({ error: 'APP_KV não configurado no ambiente da função.' }, 500);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'JSON inválido.' }, 400);
  }

  const slug = sanitizeSlug(body.slug);
  if (!slug) return jsonResponse({ error: 'Slug inválido.' }, 400);

  const payload = {
    status: body.status === 'done' ? 'done' : 'connected',
    soap: body.soap || null,
    soap_raw: String(body.soap_raw || ''),
    transcript: String(body.transcript || '')
  };

  await env.APP_KV.put(`relay:${slug}`, JSON.stringify(payload), { expirationTtl: RELAY_TTL_SECONDS });

  return jsonResponse({ ok: true }, 200);
}

function sanitizeSlug(raw) {
  if (!raw) return null;
  const slug = String(raw).toLowerCase().trim();
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;
  if (slug === 'api') return null;
  return slug;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
