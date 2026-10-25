import { FFmpeg } from '/vendor/ffmpeg/index.js';
import { t, lang, locale, AppError } from '/i18n.js';

const $ = (id) => document.getElementById(id);

const form = $('job-form');
const submitBtn = $('submit-btn');
const urlInput = $('youtube-url');
const pasteBtn = $('paste-btn');
const previewEl = $('video-preview');
const previewThumb = $('video-thumb');
const previewTitle = $('video-title');
const captchaEl = $('captcha');
const tuningModeInput = $('tuning-mode');
const tuningModeButtons = document.querySelectorAll('.tuning-btn');
const formError = $('form-error');
const panel = $('job-panel');
const statusEl = $('job-status');
const progressEl = $('job-progress');
const metaEl = $('job-meta');
const errorEl = $('job-error');
const remainingEl = $('job-remaining');
const abPlayer = $('ab-player');
const abPlay = $('ab-play');
const abOptions = document.querySelectorAll('.ab-option');
const abTunedHz = $('ab-tuned-hz');
const downloadsEl = $('downloads');
const downloadMp3 = $('download-mp3');
const downloadWav = $('download-wav');
const historySection = $('history');
const historyList = $('history-list');
const historyClear = $('history-clear');

// iPhone/iPad (incluido iPadOS, que se presenta como Mac) tienen menos memoria para WebAssembly.
const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_FILE_BYTES = (IS_IOS ? 50 : 100) * 1024 * 1024;
const MAX_AUDIO_SECONDS = 30 * 60;
const MAX_WAV_SECONDS_IOS = 10 * 60;
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 4 * 60 * 1000;
const CAPTCHA_TIMEOUT_MS = 60 * 1000;
const PREVIEW_SECONDS = 30;
const REFERENCE_A4 = 440;
const TUNING_PROFILES = { original: 440, exact: 432 };
const HISTORY_KEY = '432hz-history';
const HISTORY_MAX = 10;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

let busy = false;
let ffmpeg = null;
let current = null; // { inputName, coverSource, title, targetA4, durationSeconds, mp3Url, wavUrl }
let previewTimer = null;
let previewRequest = 0;

// ─── Utilidades ──────────────────────────────────────────────

function parseVideoId(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || !YOUTUBE_HOSTS.has(host)) {
    return null;
  }

  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else {
    id = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] ?? null;
  }

  return id && VIDEO_ID.test(id) ? id : null;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return '';
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

function safeFileName(title, extension, targetA4) {
  const clean = String(title || 'audio')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'audio';
  return `${clean} (${targetA4}Hz).${extension}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError(typeof payload.error === 'string' ? payload.error : 'unexpected');
  }
  return payload;
}

// ─── Analítica (Vercel Web Analytics, sin cookies) ───────────
// El plan gratuito no tiene eventos personalizados: cada resultado se registra como una
// visita a una ruta virtual /_evento/... que aparece en el panel de páginas.

window.va = window.va || function va(...args) {
  (window.vaq = window.vaq || []).push(args);
};

function track(name) {
  const path = `/_evento/${name}`;
  try {
    window.va('pageview', { route: path, path });
  } catch {
    // la analítica nunca debe romper la app
  }
}

// ─── Configuración pública y anti-bots (Cloudflare Turnstile) ─

let configPromise = null;
let turnstilePromise = null;
let captchaWidget = null;
let captchaWaiters = [];

function getConfig() {
  configPromise ||= fetch('/vendor/config.json')
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}));
  return configPromise;
}

function loadTurnstile() {
  turnstilePromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new AppError('captcha_unavailable')));
    script.onerror = () => {
      turnstilePromise = null;
      reject(new AppError('captcha_unavailable'));
    };
    document.head.append(script);
  });
  return turnstilePromise;
}

function settleCaptchaWaiters(token, error) {
  const waiters = captchaWaiters;
  captchaWaiters = [];
  waiters.forEach(({ resolve, reject }) => (token ? resolve(token) : reject(error)));
}

async function ensureCaptchaWidget() {
  const { turnstileSiteKey } = await getConfig();
  if (!turnstileSiteKey) {
    throw new AppError('captcha_unavailable');
  }

  const turnstile = await loadTurnstile();
  if (captchaWidget === null) {
    captchaWidget = turnstile.render(captchaEl, {
      sitekey: turnstileSiteKey,
      action: 'youtube',
      appearance: 'interaction-only',
      theme: 'dark',
      language: lang,
      callback: (token) => settleCaptchaWaiters(token),
      'error-callback': () => {
        settleCaptchaWaiters(null, new AppError('captcha'));
        return true;
      },
    });
  }
  return turnstile;
}

async function getCaptchaToken() {
  const turnstile = await ensureCaptchaWidget();
  const token = turnstile.getResponse(captchaWidget);
  if (token && !turnstile.isExpired(captchaWidget)) {
    return token;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError('captcha')), CAPTCHA_TIMEOUT_MS);
    captchaWaiters.push({
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

function resetCaptcha() {
  if (captchaWidget !== null && window.turnstile) {
    window.turnstile.reset(captchaWidget);
  }
}

// ─── Historial local (solo en este navegador) ────────────────

function readHistory() {
  try {
    const items = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(items)) return [];
    // Se valida lo leído: localStorage no es una fuente de confianza.
    return items
      .filter((item) => item && typeof item.title === 'string' && Object.values(TUNING_PROFILES).includes(item.hz))
      .map((item) => ({
        title: item.title.slice(0, 200),
        source: item.source === 'youtube' ? 'youtube' : 'file',
        videoId: VIDEO_ID.test(item.videoId) ? item.videoId : null,
        hz: item.hz,
        at: Number(item.at) || Date.now(),
      }))
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

function writeHistory(items) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_MAX)));
  } catch {
    // modo privado o almacenamiento bloqueado: el historial es opcional
  }
}

function addToHistory(entry) {
  writeHistory([{ ...entry, at: Date.now() }, ...readHistory()]);
  renderHistory();
}

function renderHistory() {
  const items = readHistory();
  historySection.classList.toggle('hidden', items.length === 0);
  historyList.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      const text = document.createElement('div');
      const title = document.createElement('span');
      const meta = document.createElement('span');
      title.className = 'history-title';
      title.textContent = item.title;
      meta.className = 'history-meta';
      meta.textContent = [
        t(`history.${item.source}`),
        `${item.hz} Hz`,
        new Date(item.at).toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
      ].join(' · ');
      text.append(title, meta);
      li.append(text);

      if (item.source === 'youtube' && item.videoId) {
        const reuse = document.createElement('button');
        reuse.type = 'button';
        reuse.className = 'link-btn';
        reuse.textContent = t('history.reuse');
        reuse.addEventListener('click', () => {
          setLink(`https://www.youtube.com/watch?v=${item.videoId}`);
          urlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        li.append(reuse);
      }
      return li;
    })
  );
}

historyClear.addEventListener('click', () => {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // nada que borrar
  }
  renderHistory();
});

// ─── Link de YouTube ──────────────────────────────────────────

function hidePreview() {
  previewRequest += 1;
  previewEl.classList.add('hidden');
  previewThumb.removeAttribute('src');
  previewTitle.textContent = '';
}

async function showPreview(videoId) {
  const request = ++previewRequest;
  previewThumb.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  previewTitle.textContent = '';
  previewEl.classList.remove('hidden');

  // Se prepara el anti-bots mientras el usuario mira la vista previa.
  ensureCaptchaWidget().catch(() => {});

  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const data = await response.json();
    if (request === previewRequest && typeof data.title === 'string') {
      previewTitle.textContent = data.title;
    }
  } catch {
    if (request === previewRequest) {
      previewTitle.textContent = t('youtubeVideo');
    }
  }
}

function onLinkChange() {
  clearTimeout(previewTimer);
  const videoId = parseVideoId(urlInput.value);

  if (!videoId) {
    hidePreview();
    return;
  }

  previewTimer = setTimeout(() => showPreview(videoId), 300);
}

function setLink(value) {
  urlInput.value = value;
  onLinkChange();
}

urlInput.addEventListener('input', onLinkChange);

if (navigator.clipboard?.readText) {
  pasteBtn.classList.remove('hidden');
  pasteBtn.addEventListener('click', async () => {
    formError.classList.add('hidden');
    try {
      const text = await navigator.clipboard.readText();
      setLink(text.trim().slice(0, 200));
      urlInput.focus();
    } catch {
      showFormError(t('pasteDenied'));
    }
  });
}

function setSelectedTuningMode(mode) {
  tuningModeInput.value = mode;
  tuningModeButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.value === mode));
  });
}

tuningModeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.value in TUNING_PROFILES) {
      setSelectedTuningMode(button.dataset.value);
    }
  });
});

setSelectedTuningMode(tuningModeInput.value || 'exact');

// ─── Vista del trabajo ───────────────────────────────────────

function setStatus(key, progress = null, params = {}) {
  panel.classList.remove('hidden');
  statusEl.textContent = t(`status.${key}`, params);
  progressEl.classList.toggle('hidden', progress === null);
  if (progress !== null && Number.isFinite(progress)) {
    progressEl.value = Math.min(1, Math.max(0, progress));
  } else {
    progressEl.removeAttribute('value'); // barra indeterminada
  }
}

function showFormError(message) {
  formError.textContent = message;
  formError.classList.remove('hidden');
}

function resetResult() {
  abReset();
  if (current?.mp3Url) URL.revokeObjectURL(current.mp3Url);
  if (current?.wavUrl) URL.revokeObjectURL(current.wavUrl);
  current = current ? { inputName: current.inputName } : null;
  downloadsEl.classList.add('hidden');
  downloadMp3.removeAttribute('href');
  downloadMp3.removeAttribute('download');
  downloadWav.classList.remove('hidden');
  metaEl.textContent = '';
  errorEl.textContent = '';
  remainingEl.textContent = '';
  formError.classList.add('hidden');
  formError.textContent = '';
}

function setBusy(value) {
  busy = value;
  submitBtn.disabled = value;
  downloadWav.disabled = value;
}

// ─── Comparador A/B ──────────────────────────────────────────

const ab = { original: null, tuned: null, active: 'tuned', playing: false };

function abReset() {
  for (const key of ['original', 'tuned']) {
    if (ab[key]) {
      ab[key].pause();
      URL.revokeObjectURL(ab[key].src);
      ab[key] = null;
    }
  }
  ab.playing = false;
  abPlayer.classList.add('hidden');
  abRender();
}

function abRender() {
  abPlay.textContent = t(ab.playing ? 'ab.pause' : 'ab.play');
  abPlay.setAttribute('aria-pressed', String(ab.playing));
  abOptions.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.ab === ab.active)));
}

function abSetup(originalUrl, tunedUrl, targetA4) {
  for (const [key, url] of [['original', originalUrl], ['tuned', tunedUrl]]) {
    const audio = new Audio(url);
    audio.loop = true;
    audio.preload = 'auto';
    ab[key] = audio;
  }
  ab.active = 'tuned';
  abTunedHz.textContent = String(targetA4);
  abPlayer.classList.remove('hidden');
  abRender();
}

abPlay.addEventListener('click', async () => {
  const audio = ab[ab.active];
  if (!audio) return;

  if (ab.playing) {
    audio.pause();
    ab.playing = false;
  } else {
    try {
      await audio.play();
      ab.playing = true;
    } catch {
      ab.playing = false;
    }
  }
  abRender();
});

abOptions.forEach((button) => {
  button.addEventListener('click', async () => {
    const next = button.dataset.ab;
    if (next === ab.active || !ab[next]) return;

    const from = ab[ab.active];
    const to = ab[next];
    to.currentTime = from.currentTime; // mismo punto de la canción en las dos versiones
    ab.active = next;
    if (ab.playing) {
      from.pause();
      try {
        await to.play();
      } catch {
        ab.playing = false;
      }
    }
    abRender();
  });
});

// ─── YouTube (vía /api/youtube) ──────────────────────────────

async function downloadWithProgress(url, statusKey) {
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok || !response.body) {
    throw new AppError('download_failed');
  }

  const total = Number(response.headers.get('content-length')) || 0;
  if (total > MAX_FILE_BYTES) {
    throw new AppError('audio_too_big');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_FILE_BYTES) {
      await reader.cancel();
      throw new AppError('audio_too_big');
    }
    chunks.push(value);
    setStatus(statusKey, total ? received / total : NaN);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

// Recorte cuadrado centrado de la miniatura (zona 16:9 del vídeo, sin las bandas negras).
// Se hace con canvas: el codificador de imágenes de ffmpeg.wasm falla con algunas miniaturas.
async function squareCover(blob) {
  const image = await createImageBitmap(blob);
  const side = Math.round(Math.min(image.height, (image.width * 9) / 16));
  const size = Math.min(side, 720);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
  image.close();
  const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return jpeg ? new Uint8Array(await jpeg.arrayBuffer()) : null;
}

// Carátula: la miniatura del vídeo (si no hay versión HD, la normal). Si falla, el MP3 va sin carátula.
async function fetchCover(videoId) {
  for (const name of ['maxresdefault', 'hqdefault']) {
    try {
      const response = await fetch(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (response.ok && (response.headers.get('content-type') || '').startsWith('image/jpeg')) {
        return await squareCover(await response.blob());
      }
    } catch {
      // se prueba la siguiente
    }
  }
  return null;
}

async function fetchYoutubeAudio(link, videoId) {
  setStatus('checking', NaN);
  const captcha = await getCaptchaToken();

  setStatus('preparing', NaN);
  let started;
  try {
    started = await readJson(
      await fetch('/api/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: link, captcha }),
      })
    );
  } finally {
    resetCaptcha(); // cada token de Turnstile solo sirve una vez
  }

  const jobQuery = `/api/youtube?job=${encodeURIComponent(started.job)}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let result;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    result = await readJson(await fetch(jobQuery));
    if (result.status !== 'downloading') break;
    setStatus('downloading', NaN);
  }

  if (!result || result.status === 'downloading') {
    throw new AppError('slow');
  }
  if (result.status !== 'ready') {
    throw new AppError(result.error || 'download_failed');
  }

  const audioUrl = new URL(result.audioUrl);
  if (audioUrl.protocol !== 'https:' || audioUrl.hostname !== 'api.apify.com') {
    throw new AppError('bad_response');
  }

  const [bytes, cover] = await Promise.all([downloadWithProgress(audioUrl.toString(), 'receiving'), fetchCover(videoId)]);

  // El audio ya está en el navegador: se borra la copia de Apify.
  fetch(jobQuery, { method: 'DELETE', keepalive: true }).catch(() => {});

  return {
    bytes,
    cover,
    extension: audioUrl.pathname.split('.').pop().toLowerCase(),
    title: result.title || t('youtubeVideo'),
    remaining: started.remaining,
  };
}

// ─── Conversión en el navegador (ffmpeg.wasm) ────────────────

async function getFFmpeg() {
  if (ffmpeg?.loaded) {
    return ffmpeg;
  }

  setStatus('loadingEngine', NaN);
  ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: '/vendor/ffmpeg-core/ffmpeg-core.js',
    wasmURL: '/vendor/ffmpeg-core/ffmpeg-core.wasm',
  });
  return ffmpeg;
}

async function probeInput(engine, inputName) {
  await engine.ffprobe(['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputName, '-o', 'probe.txt']);
  const lines = String(await engine.readFile('probe.txt', 'utf8').catch(() => '')).split('\n').map((line) => line.trim());
  await engine.deleteFile('probe.txt').catch(() => {});
  const seconds = Number.parseFloat(lines.find((line) => /^\d+(\.\d+)?$/.test(line)));
  return { durationSeconds: Number.isFinite(seconds) ? seconds : null, hasVideo: lines.includes('video') };
}

function retuneFilter(targetA4) {
  if (targetA4 === REFERENCE_A4) {
    return [];
  }
  // Baja el tono (asetrate) y corrige el tempo (atempo) para mantener la duración.
  const resample = 'aresample=44100:filter_size=64:phase_shift=10:cutoff=0.97';
  return ['-af', `aresample=44100,asetrate=44100*${targetA4}/${REFERENCE_A4},${resample},atempo=${REFERENCE_A4}/${targetA4}`];
}

function coverArgs(withCover) {
  if (!withCover || !current.coverSource) {
    return ['-map', '0:a:0'];
  }
  // La imagen se copia tal cual (sin recodificar): miniatura de YouTube ya recortada, o la carátula del archivo.
  const fromYoutube = current.coverSource === 'youtube';
  return [
    ...(fromYoutube ? ['-i', 'cover.jpg', '-map', '0:a:0', '-map', '1:v:0'] : ['-map', '0:a:0', '-map', '0:v:0']),
    '-c:v', 'copy',
    '-disposition:v', 'attached_pic',
    '-metadata:s:v', 'title=Album cover',
    '-metadata:s:v', 'comment=Cover (front)',
  ];
}

async function runFFmpeg(args, statusKey, durationSeconds) {
  const engine = await getFFmpeg();
  const onProgress = ({ time }) => {
    setStatus(statusKey, durationSeconds ? time / 1e6 / durationSeconds : NaN, { hz: current.targetA4 });
  };

  setStatus(statusKey, NaN, { hz: current.targetA4 });
  engine.on('progress', onProgress);
  try {
    return await engine.exec(args);
  } finally {
    engine.off('progress', onProgress);
  }
}

async function readOutput(name, type) {
  const engine = await getFFmpeg();
  const data = await engine.readFile(name);
  await engine.deleteFile(name).catch(() => {});
  return URL.createObjectURL(new Blob([data], { type }));
}

async function encodeMp3() {
  const metadata = ['-id3v2_version', '3', '-metadata', `title=${current.title}`, '-metadata', `comment=Retuned to A4=${current.targetA4} Hz`];
  const build = (withCover) => [
    '-i', current.inputName,
    ...coverArgs(withCover),
    ...retuneFilter(current.targetA4),
    '-ac', '2', '-ar', '44100',
    '-codec:a', 'libmp3lame', '-b:a', '320k',
    ...metadata,
    'output.mp3',
  ];

  let exitCode = await runFFmpeg(build(true), 'converting', current.durationSeconds);
  if (exitCode !== 0) {
    // Si la carátula da problemas, se convierte sin ella antes que fallar.
    exitCode = await runFFmpeg(build(false), 'converting', current.durationSeconds);
  }
  if (exitCode !== 0) {
    throw new AppError('convert_failed');
  }
  return readOutput('output.mp3', 'audio/mpeg');
}

async function encodeWav() {
  const exitCode = await runFFmpeg(
    ['-i', current.inputName, '-map', '0:a:0', ...retuneFilter(current.targetA4), '-ac', '2', '-ar', '44100', '-codec:a', 'pcm_s16le', 'output.wav'],
    'wav',
    current.durationSeconds
  );
  if (exitCode !== 0) {
    throw new AppError('convert_failed');
  }
  return readOutput('output.wav', 'audio/wav');
}

// Dos fragmentos cortos del mismo tramo (original y convertido) para el comparador.
async function encodePreviewClips() {
  const duration = current.durationSeconds || PREVIEW_SECONDS;
  const length = Math.min(PREVIEW_SECONDS, duration);
  const start = duration > PREVIEW_SECONDS + 10 ? Math.min(duration * 0.3, duration - PREVIEW_SECONDS) : 0;
  const clip = (filter, name) => [
    '-ss', start.toFixed(2), '-t', length.toFixed(2), '-i', current.inputName,
    '-map', '0:a:0', ...filter, '-ac', '2', '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '160k', name,
  ];

  if ((await runFFmpeg(clip([], 'ab-original.mp3'), 'preview', length)) !== 0) return null;
  if ((await runFFmpeg(clip(retuneFilter(current.targetA4), 'ab-tuned.mp3'), 'preview', length)) !== 0) return null;
  return [await readOutput('ab-original.mp3', 'audio/mpeg'), await readOutput('ab-tuned.mp3', 'audio/mpeg')];
}

async function loadInput({ bytes, cover, extension, title }, targetA4) {
  const engine = await getFFmpeg();
  for (const name of [current?.inputName, 'cover.jpg']) {
    if (name) await engine.deleteFile(name).catch(() => {});
  }

  const inputName = `input.${/^[a-z0-9]{2,5}$/.test(extension) ? extension : 'bin'}`;
  await engine.writeFile(inputName, bytes);
  if (cover) {
    await engine.writeFile('cover.jpg', cover);
  }

  const { durationSeconds, hasVideo } = await probeInput(engine, inputName);
  if (durationSeconds && durationSeconds > MAX_AUDIO_SECONDS) {
    throw new AppError('too_long', { min: MAX_AUDIO_SECONDS / 60 });
  }

  const coverSource = cover ? 'youtube' : hasVideo ? 'embedded' : null;
  current = { inputName, coverSource, title, targetA4, durationSeconds, mp3Url: null, wavUrl: null };
}

function triggerDownload(url, fileName) {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
}

downloadWav.addEventListener('click', async () => {
  if (!current?.mp3Url || busy) return;

  setBusy(true);
  errorEl.textContent = '';
  try {
    current.wavUrl ||= await encodeWav();
    setStatus('done');
    triggerDownload(current.wavUrl, safeFileName(current.title, 'wav', current.targetA4));
  } catch (error) {
    setStatus('error');
    errorEl.textContent = error instanceof AppError ? error.message : t('errors.convert_failed');
  } finally {
    setBusy(false);
  }
});

// ─── Envío ───────────────────────────────────────────────────

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;

  resetResult();
  const link = urlInput.value.trim();
  const videoId = link ? parseVideoId(link) : null;
  const targetA4 = TUNING_PROFILES[tuningModeInput.value] ?? TUNING_PROFILES.exact;

  if (!link) {
    showFormError(t('errors.empty'));
    return;
  }
  if (!videoId) {
    showFormError(t('errors.invalid_url'));
    return;
  }

  setBusy(true);
  const startedAt = performance.now();

  try {
    const source = await fetchYoutubeAudio(link, videoId);

    await loadInput(source, targetA4);
    current.mp3Url = await encodeMp3();

    if (targetA4 !== REFERENCE_A4) {
      const clips = await encodePreviewClips().catch(() => null);
      if (clips) abSetup(clips[0], clips[1], targetA4);
    }

    downloadMp3.href = current.mp3Url;
    downloadMp3.download = safeFileName(current.title, 'mp3', targetA4);
    downloadWav.classList.toggle('hidden', IS_IOS && (current.durationSeconds || 0) > MAX_WAV_SECONDS_IOS);
    downloadsEl.classList.remove('hidden');

    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    setStatus('done');
    metaEl.textContent = [current.title, formatDuration(current.durationSeconds), `${targetA4} Hz`, `${seconds} s`]
      .filter(Boolean)
      .join(' · ');
    if (Number.isInteger(source.remaining)) {
      remainingEl.textContent = source.remaining === 1 ? t('remainingOne') : t('remaining', { n: source.remaining });
    }

    addToHistory({ title: current.title, source: 'youtube', videoId, hz: targetA4 });
    track('youtube-ok');
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'unexpected';
    if (code === 'unexpected') {
      console.error(error);
      // Si el motor de audio se ha roto, se descarta para que el siguiente intento empiece limpio.
      ffmpeg?.terminate();
      ffmpeg = null;
      current = null;
    }
    setStatus('error');
    errorEl.textContent = error instanceof AppError ? error.message : t('errors.unexpected');
    track(`youtube-error-${code}`);
  } finally {
    setBusy(false);
  }
});

renderHistory();
