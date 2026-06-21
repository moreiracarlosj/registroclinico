// functions/api/templates.js
//
// Bloco de modelos pessoal — texto livre (receitas, posologias) salvo por
// slug, sem login. Funciona como o "bloco de notas" do invertexto.com: quem
// sabe a URL/slug lê e escreve esse bloco.
//
// IMPORTANTE: diferente do resto do app, isso É persistente (fica salvo até
// ser sobrescrito). Por isso é só para modelos genéricos — nunca deveria
// guardar dado de paciente aqui.

const MAX_TEXT_LENGTH = 50000; // ~50 KB, generoso pra texto de modelos

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.APP_KV) return jsonResponse({ error: 'APP_KV não configurado no ambiente da função.' }, 500);

  const slug = sanitizeSlug(new URL(request.url).searchParams.get('slug'));
  if (!slug) return jsonResponse({ error: 'Slug inválido.' }, 400);

  const value = await env.APP_KV.get(`tpl:${slug}`);
  return jsonResponse({ text: value || '' }, 200);
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

  const text = String(body.text || '').slice(0, MAX_TEXT_LENGTH);
  await env.APP_KV.put(`tpl:${slug}`, text);

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
