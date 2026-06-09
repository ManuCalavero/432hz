const path = require('path');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const { port, rootDir, outputDir, tuningProfiles } = require('./config');
const { ensureStore, createJob, updateJob, getJob, getJobs } = require('./store');
const { InMemoryQueue } = require('./queue');
const { normalizeYouTubeUrl, assertVideoConstraints, convertTo432Hz } = require('./audio');

const app = express();

const DOWNLOAD_LIMIT_PER_HOUR = 5;
const DOWNLOAD_WINDOW_MS = 60 * 60 * 1000;
const downloadRateStore = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "connect-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", 'https://fonts.googleapis.com'],
        "font-src": ["'self'", 'https://fonts.gstatic.com', 'data:'],
        "img-src": ["'self'", 'data:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use(express.static(path.join(rootDir, 'public'), { dotfiles: 'deny' }));

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }

  return req.ip || req.socket.remoteAddress || 'unknown';
}

function canDownload(ip) {
  const now = Date.now();
  const start = now - DOWNLOAD_WINDOW_MS;
  const attempts = (downloadRateStore.get(ip) || []).filter((ts) => ts > start);

  if (attempts.length >= DOWNLOAD_LIMIT_PER_HOUR) {
    const retryAfterSeconds = Math.max(1, Math.ceil((attempts[0] + DOWNLOAD_WINDOW_MS - now) / 1000));
    downloadRateStore.set(ip, attempts);
    return { allowed: false, retryAfterSeconds };
  }

  attempts.push(now);
  downloadRateStore.set(ip, attempts);
  return { allowed: true, retryAfterSeconds: 0 };
}

function nowIso() {
  return new Date().toISOString();
}

function toAdminLog(job) {
  return {
    id: job.id,
    url: job.url,
    tuningMode: job.tuningMode,
    targetA4: job.targetA4,
    status: job.status,
    result: job.result,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveDownloadPath(job, format) {
  const expectedFileName = `${job.id}.${format}`;
  const outputPath = format === 'wav' ? job.outputWavPath : job.outputMp3Path;
  const normalizedOutputDir = path.resolve(outputDir) + path.sep;
  const canonicalPath = path.join(outputDir, expectedFileName);

  if (await fileExists(canonicalPath)) {
    return { path: canonicalPath, migrated: false };
  }

  if (typeof outputPath !== 'string' || outputPath.trim() === '') {
    return { path: null, migrated: false };
  }

  const normalizedOutputPath = path.resolve(outputPath);
  if (path.basename(normalizedOutputPath) !== expectedFileName) {
    return { path: null, migrated: false };
  }

  if (!(await fileExists(normalizedOutputPath))) {
    return { path: null, migrated: false };
  }

  if (normalizedOutputPath.startsWith(normalizedOutputDir)) {
    return { path: normalizedOutputPath, migrated: false };
  }

  // Legacy compatibility: old jobs may point to a previous workspace folder.
  try {
    await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
    await fs.copyFile(normalizedOutputPath, canonicalPath);
    return { path: canonicalPath, migrated: true };
  } catch {
    return { path: null, migrated: false };
  }
}

const queue = new InMemoryQueue(async (payload) => {
  const { jobId, url, targetA4 } = payload;

  const startedAt = nowIso();
  await updateJob(jobId, {
    status: 'downloading',
    startedAt,
  });

  try {
    await updateJob(jobId, { status: 'retuning' });
    const outputs = await convertTo432Hz({ url, jobId, targetA4 });

    const finishedAt = nowIso();
    const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    await updateJob(jobId, {
      status: 'completed',
      result: 'ok',
      finishedAt,
      durationMs,
      targetA4: outputs.appliedTargetA4,
      outputWavPath: outputs.wavPath,
      outputMp3Path: outputs.mp3Path,
      error: null,
    });
  } catch (error) {
    const finishedAt = nowIso();
    const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    await updateJob(jobId, {
      status: 'failed',
      result: 'ko',
      finishedAt,
      durationMs,
      error: error.message,
    });
  }
});

app.post('/api/jobs', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    res.status(400).json({ error: 'Cuerpo de solicitud invalido.' });
    return;
  }

  const rawUrl = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (rawUrl.length > 2048) {
    res.status(400).json({ error: 'La URL es demasiado larga.' });
    return;
  }

  const requestedMode = typeof req.body.tuningMode === 'string' ? req.body.tuningMode : 'exact';
  const tuningMode = requestedMode in tuningProfiles ? requestedMode : 'exact';
  const targetA4 = tuningProfiles[tuningMode];
  const url = normalizeYouTubeUrl(rawUrl);

  if (!url) {
    res.status(400).json({ error: 'Debes indicar una URL de YouTube.' });
    return;
  }

  try {
    await assertVideoConstraints(url);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  const job = {
    id: randomUUID(),
    url,
    status: 'queued',
    result: null,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    tuningMode,
    targetA4,
    outputWavPath: null,
    outputMp3Path: null,
    error: null,
  };

  await createJob(job);
  queue.add({ jobId: job.id, url, targetA4 });

  res.status(202).json({
    id: job.id,
    status: job.status,
    tuningMode,
    targetA4,
  });
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);

  if (!job) {
    res.status(404).json({ error: 'Trabajo no encontrado.' });
    return;
  }

  res.json({
    id: job.id,
    url: job.url,
    status: job.status,
    result: job.result,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    tuningMode: job.tuningMode,
    targetA4: job.targetA4,
    error: job.error,
    downloads:
      job.status === 'completed'
        ? {
            wav: `/api/download/${job.id}/wav`,
            mp3: `/api/download/${job.id}/mp3`,
          }
        : null,
  });
});

app.get('/api/jobs', async (_req, res) => {
  const jobs = await getJobs();
  res.json(jobs);
});

app.get('/api/admin/logs', async (_req, res) => {
  const jobs = await getJobs();
  res.json(jobs.map(toAdminLog));
});

app.get('/api/download/:id/:format', async (req, res) => {
  const { id, format } = req.params;
  if (format !== 'wav' && format !== 'mp3') {
    res.status(400).json({ error: 'Formato no soportado.' });
    return;
  }

  const job = await getJob(id);
  const clientIp = getClientIp(req);

  if (!job || job.status !== 'completed') {
    res.status(404).json({ error: 'Archivo no disponible.' });
    return;
  }

  const resolved = await resolveDownloadPath(job, format);
  if (!resolved.path) {
    res.status(404).json({ error: 'El archivo no existe en disco.' });
    return;
  }

  if (resolved.migrated) {
    await updateJob(id, {
      outputWavPath: format === 'wav' ? resolved.path : job.outputWavPath,
      outputMp3Path: format === 'mp3' ? resolved.path : job.outputMp3Path,
    });
  }

  const rate = canDownload(clientIp);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({ error: 'Limite alcanzado: maximo 5 descargas por hora.' });
    return;
  }

  res.download(resolved.path, `${id}.${format}`);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

async function start() {
  await ensureStore();

  app.listen(port, () => {
    console.log(`cooler listening on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error('Unable to start server:', error);
  process.exitCode = 1;
});
