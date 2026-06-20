# Consulta → Registro

App de uma página: grava a consulta, transcreve com IA e gera o registro clínico em SOAP, editável e exportável.

## Estrutura

```
index.html                  ← página única (frontend)
functions/api/structure.js  ← caminho PADRÃO: só texto (já transcrito no navegador), modelo barato (llama-3.1-8b-instant)
functions/api/process.js    ← caminho de RESERVA: Whisper + estruturação, usado só quando o navegador não tem reconhecimento de voz nativo
```

Por padrão, o áudio nunca sai do navegador. A transcrição usa o reconhecimento de voz nativo do navegador (Web Speech API) — gratuito, roda no próprio dispositivo. Quando a gravação termina, só o texto já transcrito é enviado para `/api/structure`, que pede pra IA organizar nos 4 campos do registro. Isso é praticamente gratuito: um modelo pequeno, sem chamada de transcrição nenhuma.

`/api/process` (com Whisper, mais caro) só entra em ação como reserva: navegadores sem suporte a reconhecimento de voz (Firefox, Safari mais antigo), ou se a transcrição ao vivo vier vazia/curta demais. Há também uma rede de segurança automática: se `/api/structure` falhar por qualquer motivo, o app tenta `/api/process` com o áudio gravado antes de desistir.

Durante a gravação, o painel de "o que está faltando" não chama IA nenhuma — usa um detector de palavras-chave 100% local no navegador (ex.: menção a "PA", "ausculta", "febre" etc.) só pra sinalizar o que já foi tocado. O texto final, bem redigido, só é gerado uma vez, quando a gravação para.

Funciona bem no Chrome e no Edge; no Safari o suporte a reconhecimento de voz varia; no Firefox não há suporte nativo (esses casos caem automaticamente no caminho de reserva com Whisper).

O `index.html` nunca fala diretamente com a IA. Ele envia o áudio para `/api/process`, que roda no servidor da Cloudflare e é o único lugar que conhece sua chave de API. Assim a chave nunca fica exposta no navegador.

## Passo 1 — Conta na Groq (transcrição + IA, gratuito)

1. Crie uma conta em https://console.groq.com (sem necessidade de cartão de crédito).
2. Em **API Keys**, gere uma chave e guarde-a — você vai usá-la só uma vez, no painel da Cloudflare.
3. A camada gratuita cobre tranquilamente o uso de um único consultório: milhares de transcrições e gerações de texto por dia.

## Passo 2 — Subir o projeto para o GitHub

1. Crie um repositório novo (pode ser privado) e suba estes dois arquivos/pastas mantendo a estrutura acima (`index.html` na raiz, `functions/api/process.js` no caminho exato).

## Passo 3 — Deploy na Cloudflare Pages (gratuito)

1. Acesse https://dash.cloudflare.com → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Selecione o repositório. Em *Build settings*, não é necessário nenhum comando de build — deixe em branco (é um site estático). *Output directory*: `/` (raiz).
3. Finalize o deploy. A Cloudflare detecta automaticamente a pasta `functions/` e publica `process.js` como endpoint `/api/process`.

## Passo 4 — Configurar a chave da API

1. No projeto criado, vá em **Settings → Environment variables**.
2. Adicione uma variável: nome `GROQ_API_KEY`, valor = a chave que você gerou no Passo 1. Marque como **Secret/Encrypted**.
3. Aplique para o ambiente de produção (e preview, se quiser testar antes).
4. Faça um novo deploy (ou "Retry deployment") para a variável entrar em vigor.

Pronto — seu site estará em algo como `https://seu-projeto.pages.dev`, acessível de qualquer navegador com microfone, sem nenhum custo de hospedagem.

## Testando localmente (opcional)

Se quiser testar antes de publicar:

```bash
npm install -g wrangler
wrangler pages dev . --binding GROQ_API_KEY=sua_chave_aqui
```

## Sobre privacidade (LGPD)

Este app lida com dados sensíveis de pacientes (art. 11 da LGPD). Pontos a considerar antes de usar em consultas reais:

- **Nada fica salvo no servidor.** O áudio é processado e descartado a cada requisição — não há banco de dados neste projeto.
- Evite que o paciente cite nome completo, CPF ou outros identificadores diretos durante a gravação (já há um lembrete disso na própria tela).
- O áudio e a transcrição passam pelos servidores da Groq durante o processamento. Vale ler os termos de uso e a política de retenção de dados deles antes de adotar em produção: https://groq.com/privacy-policy/
- Sempre revise o texto gerado pela IA antes de colar no prontuário oficial — é um rascunho, não um documento validado.

Isto não é orientação jurídica. Se for usar com pacientes reais de forma rotineira, vale uma checagem com alguém de compliance/jurídico.

## Possíveis ajustes futuros

- Trocar o modelo de geração (`CHAT_MODEL` em `process.js`) por outro disponível na Groq, se quiser testar qualidade diferente.
- Adicionar um campo opcional de "observações" antes de gravar.
- Limitar a duração máxima da gravação no frontend, se preferir.
