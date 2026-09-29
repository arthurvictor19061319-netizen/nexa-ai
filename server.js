const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gemini-3.5-flash-lite';
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 700);
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 30);

if (!GEMINI_API_KEY) {
  console.warn('[Nexa] GEMINI_API_KEY não está definida. Configure a variável de ambiente antes de usar o chat.');
}

app.set('trust proxy', true);
app.use(express.json({ limit: '20mb' }));

const requestLog = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = requestLog.get(ip);
  if (!entry || now - entry.windowStart >= 60_000) {
    entry = { windowStart: now, count: 0 };
    requestLog.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_PER_MINUTE) {
    return res.status(429).json({ error: 'Muitas mensagens em pouco tempo. Tente novamente em alguns segundos.' });
  }
  next();
}

const allowedModels = new Set([
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash'
]);

function chosenThinkingLevel(model) {
  if (model === 'gemini-3.5-flash-lite') return 'minimal';
  if (model === 'gemini-3.8-flash' || model === 'gemini-3.7-flash' || model === 'gemini-3.6-flash') return 'low';
  return undefined;
}

function shouldUseWebSearch(contents) {
  const text = [...(contents || [])]
    .reverse()
    .find(x => x && x.role === 'user')?.parts
    ?.filter(p => typeof p?.text === 'string')
    .map(p => p.text)
    .join(' ') || '';

  const temporal = /(hoje|agora|atual|atualmente|últim[ao]s?|recentemente|essa semana|esta semana|ontem|trend|trending|bombando|viral|novidade|lançad[oa]|2026|preço|ranking|top|meta)/i.test(text);
  const topics = /(tiktok|roblox|free fire|freefire|minecraft|mapa|mapas|meme|skin|evento|atualização|update|patch|temporada|viral)/i.test(text);
  return temporal && topics;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(GEMINI_API_KEY), model: DEFAULT_MODEL });
});

app.post('/api/chat', rateLimit, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'O servidor ainda não configurou GEMINI_API_KEY.' });
  }

  const body = req.body || {};
  const requestedModel = String(body.model || DEFAULT_MODEL);
  const model = allowedModels.has(requestedModel) ? requestedModel : DEFAULT_MODEL;
  const contents = Array.isArray(body.contents) ? body.contents : [];
  const systemInstruction = body.systemInstruction && typeof body.systemInstruction === 'object'
    ? body.systemInstruction
    : undefined;

  if (!contents.length) {
    return res.status(400).json({ error: 'Nenhuma mensagem foi enviada.' });
  }

  const requestBody = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS }
  };

  const thinkingLevel = chosenThinkingLevel(model);
  if (thinkingLevel) {
    requestBody.generationConfig.thinkingConfig = { thinkingLevel };
  }

  if (shouldUseWebSearch(contents)) {
    requestBody.tools = [{ google_search: {} }];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify(requestBody)
    });

    if (!upstream.ok) {
      const raw = await upstream.text();
      let message = `Gemini respondeu HTTP ${upstream.status}`;
      try {
        const data = JSON.parse(raw);
        message = data?.error?.message || message;
      } catch {}
      return res.status(upstream.status).json({ error: message });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    for await (const chunk of upstream.body) {
      if (res.writableEnded) break;
      res.write(Buffer.from(chunk));
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({ error: `Falha ao conectar ao Gemini: ${error.message}` });
    } else {
      res.end();
    }
  }
});

app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'NexaAI.html')));

app.listen(PORT, () => {
  console.log(`[Nexa] rodando em http://localhost:${PORT}`);
});
