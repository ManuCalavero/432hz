// Función serverless de Vercel: descarga el audio de un vídeo de YouTube a través de Apify.
// El token de Apify solo vive aquí (variable de entorno APIFY_TOKEN); el navegador recibe
// un "job" firmado y, al terminar, una URL firmada de solo lectura para ese audio.
//
//   POST   /api/youtube         { url, captcha } -> { job, remaining }
//   GET    /api/youtube?job=...                  -> { status: 'downloading' | 'ready' | 'failed', ... }
//   DELETE /api/youtube?job=...                  -> borra el audio de Apify cuando el navegador ya lo tiene
//
// Los errores se devuelven como { error: <código> } y el navegador los traduce.

const crypto = require('crypto');

const APIFY_API = 'https://api.apify.com/v2';
const ACTOR = 'utils~youtube-link';
const LIMITS_STORE = '432hz-limits';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TELEGRAM_API = 'https://api.telegram.org';
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_CHARGE_PER_RUN_USD = '0.10';
const RUN_TIMEOUT_SECONDS = 180;
const MAX_AUDIO_SECONDS = 30 * 60;
const USER_DAILY_LIMIT = 5;
const GLOBAL_DAILY_LIMIT = Number(process.env.YOUTUBE_DAILY_LIMIT) || 30;
const AUDIO_FILENAME = /^[A-Za-z0-9_-]{11}\.(webm|m4a|mp3|opus|ogg)$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

let limitsStoreId = null;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function getToken() {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new HttpError(503, 'not_configured');
  }
  return token;
}

function deriveKey(purpose) {
  return crypto.createHmac('sha256', getToken()).update(purpose).digest();
}

function signJob(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', deriveKey('432hz-job-signing')).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyJob(job) {
  if (typeof job !== 'string' || job.length > 512) {
    throw new HttpError(400, 'invalid_job');
  }

  const [body, signature] = job.split('.');
  if (!body || !signature) {
    throw new HttpError(400, 'invalid_job');
  }

  const expected = crypto.createHmac('sha256', deriveKey('432hz-job-signing')).update(body).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    throw new HttpError(403, 'invalid_job');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_job');
  }
  if (typeof payload?.r !== 'string' || typeof payload.e !== 'number') {
    throw new HttpError(400, 'invalid_job');
  }
  if (payload.e < Date.now()) {
    throw new HttpError(410, 'expired_job');
  }
  return payload;
}

function parseVideoId(input) {
  if (typeof input !== 'string' || input.length > 200) {
    return null;
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    return null;
  }

  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else {
    const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
    id = match ? match[1] : null;
  }

  return id && VIDEO_ID.test(id) ? id : null;
}

function encodeBase62(num) {
  const charset = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  while (num > 0n) {
    result = charset[Number(num % 62n)] + result;
    num /= 62n;
  }
  return result || '0';
}

// Mismo algoritmo que apify-client (getRecordPublicUrl): firma de solo lectura para un registro.
function signedRecordUrl(storeId, key, urlSigningSecretKey) {
  const hex = crypto.createHmac('sha256', urlSigningSecretKey).update(key).digest('hex').substring(0, 30);
  const url = new URL(`${APIFY_API}/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(key)}`);
  url.searchParams.set('signature', encodeBase62(BigInt(`0x${hex}`)));
  return url.toString();
}

async function apify(pathname, options = {}) {
  const response = await fetch(`${APIFY_API}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });

  if (response.status === 204) {
    return null;
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // Nunca se reenvía al navegador el detalle de Apify.
    console.error(`Apify ${options.method || 'GET'} ${pathname.split('?')[0]} -> ${response.status} ${body?.error?.type || ''}`);
    if (response.status === 404 && options.allowNotFound) {
      return null;
    }
    throw new HttpError(response.status === 402 ? 503 : 502, response.status === 402 ? 'quota_exhausted' : 'upstream');
  }
  return body?.data ?? body;
}

function getClientIp(req) {
  const forwarded = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0];
  return forwarded.trim() || 'unknown';
}

function assertSameOrigin(req) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') {
    throw new HttpError(403, 'origin');
  }

  const origin = req.headers.origin;
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // origen malformado: se rechaza abajo
    }
    if (originHost !== req.headers.host) {
      throw new HttpError(403, 'origin');
    }
  }
}

async function assertHuman(req, captcha) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Sin anti-bots configurado, la descarga desde YouTube queda desactivada (falla cerrado).
    throw new HttpError(503, 'not_configured');
  }
  if (typeof captcha !== 'string' || captcha.length === 0 || captcha.length > 2048) {
    throw new HttpError(403, 'captcha');
  }

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, response: captcha, remoteip: getClientIp(req) }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  const result = await response?.json().catch(() => null);

  // Las claves de prueba de Cloudflare no devuelven action ni hostname reales: solo se aceptan fuera de producción.
  const isTestKey = result?.metadata?.result_with_testing_key === true;
  if (isTestKey && process.env.VERCEL_ENV === 'production') {
    throw new HttpError(403, 'captcha');
  }

  const expectedHost = String(req.headers.host || '').split(':')[0];
  const hostMatches = !process.env.VERCEL_ENV || isTestKey || result?.hostname === expectedHost;
  const actionMatches = isTestKey || result?.action === 'youtube';
  if (!result?.success || !actionMatches || !hostMatches) {
    throw new HttpError(403, 'captcha');
  }
}

async function getLimitsStoreId() {
  if (!limitsStoreId) {
    const store = await apify(`/key-value-stores?name=${LIMITS_STORE}`, { method: 'POST' });
    limitsStoreId = store.id;
  }
  return limitsStoreId;
}

// Contador por usuario y día guardado en un almacén con nombre de Apify (Vercel gratis no tiene base de datos).
// La IP nunca se guarda: solo un hash con clave secreta.
async function consumeUserQuota(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const userKey = crypto.createHmac('sha256', deriveKey('432hz-ip-hash')).update(ip).digest('hex').slice(0, 24);
  const recordKey = `day-${day}`;
  const storeId = await getLimitsStoreId();
  const recordPath = `/key-value-stores/${storeId}/records/${recordKey}`;

  const counts = (await apify(recordPath, { allowNotFound: true })) || {};
  const used = Number(counts[userKey]) || 0;
  if (used >= USER_DAILY_LIMIT) {
    throw new HttpError(429, 'user_limit');
  }

  counts[userKey] = used + 1;
  await apify(recordPath, { method: 'PUT', body: JSON.stringify(counts) });
  return USER_DAILY_LIMIT - counts[userKey];
}

async function assertGlobalLimit() {
  const runs = await apify(`/acts/${ACTOR}/runs?desc=1&limit=${GLOBAL_DAILY_LIMIT}`);
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = (runs.items || []).filter((run) => new Date(run.startedAt).getTime() > since);
  if (recent.length >= GLOBAL_DAILY_LIMIT) {
    throw new HttpError(429, 'global_limit');
  }
}

// Aviso opcional por Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). Si falla o no está configurado,
// la conversión sigue igual. Se espera con un tiempo límite corto porque en Vercel la función se congela
// en cuanto responde y un envío sin esperar se perdería.
async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return;
  }

  try {
    await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    console.error('telegram notify failed');
  }
}

async function startJob(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'unsupported');
  }

  const videoId = parseVideoId(req.body?.url);
  if (!videoId) {
    throw new HttpError(400, 'invalid_url');
  }

  await assertHuman(req, req.body?.captcha);
  await assertGlobalLimit();
  const remaining = await consumeUserQuota(getClientIp(req));

  const query = new URLSearchParams({
    timeout: String(RUN_TIMEOUT_SECONDS),
    maxTotalChargeUsd: MAX_CHARGE_PER_RUN_USD,
  });
  const run = await apify(`/acts/${ACTOR}/runs?${query}`, {
    method: 'POST',
    // Se reconstruye la URL a partir del ID: nunca se envía a Apify el texto del usuario.
    body: JSON.stringify({ videos: [{ url: `https://www.youtube.com/watch?v=${videoId}` }], audioQuality: 'best' }),
  });

  await notifyTelegram(`🎵 Nuevo link para convertir\nhttps://www.youtube.com/watch?v=${videoId}\nA este usuario le quedan ${remaining} hoy`);

  return { job: signJob({ r: run.id, v: videoId, e: Date.now() + JOB_TTL_MS }), remaining };
}

async function getJobStatus(job) {
  const { r: runId } = verifyJob(job);
  const run = await apify(`/actor-runs/${encodeURIComponent(runId)}`);

  if (run.status === 'READY' || run.status === 'RUNNING') {
    return { status: 'downloading' };
  }

  if (run.status !== 'SUCCEEDED') {
    return { status: 'failed', error: 'download_failed' };
  }

  const items = await apify(`/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&limit=1`);
  const item = Array.isArray(items) ? items[0] : null;

  if (!item?.ok || typeof item.filename !== 'string' || !AUDIO_FILENAME.test(item.filename)) {
    return { status: 'failed', error: 'video_unavailable' };
  }

  if (Number(item.duration) > MAX_AUDIO_SECONDS) {
    return { status: 'failed', error: 'too_long' };
  }

  const store = await apify(`/key-value-stores/${encodeURIComponent(run.defaultKeyValueStoreId)}`);
  if (!store?.urlSigningSecretKey) {
    return { status: 'failed', error: 'download_failed' };
  }

  return {
    status: 'ready',
    title: typeof item.title === 'string' ? item.title.slice(0, 200) : '',
    durationSeconds: Number(item.duration) || null,
    audioUrl: signedRecordUrl(run.defaultKeyValueStoreId, item.filename, store.urlSigningSecretKey),
  };
}

async function deleteJobAudio(job) {
  const { r: runId } = verifyJob(job);
  const run = await apify(`/actor-runs/${encodeURIComponent(runId)}`);
  if (run.status === 'READY' || run.status === 'RUNNING') {
    throw new HttpError(409, 'still_running');
  }
  await apify(`/key-value-stores/${encodeURIComponent(run.defaultKeyValueStoreId)}`, { method: 'DELETE' });
  return { deleted: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    assertSameOrigin(req);

    let result;
    if (req.method === 'POST') {
      result = await startJob(req);
    } else if (req.method === 'GET') {
      result = await getJobStatus(req.query.job);
    } else if (req.method === 'DELETE') {
      result = await deleteJobAudio(req.query.job);
    } else {
      res.setHeader('Allow', 'GET, POST, DELETE');
      throw new HttpError(405, 'method');
    }

    res.status(200).json(result);
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    console.error('youtube handler error:', error.name);
    res.status(500).json({ error: 'unexpected' });
  }
};

module.exports.parseVideoId = parseVideoId;
