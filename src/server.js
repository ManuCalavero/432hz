require('dotenv').config();

const path = require('path');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const morgan = require('morgan');
const { port, rootDir, tmpDir, outputDir, maxUploadBytes, tuningProfiles } = require('./config');
const { createJob, updateJob, getJob } = require('./store');
const { InMemoryQueue } = require('./queue');
const { assertAudioConstraints, convertTo432Hz } = require('./audio');
const youtubeHandler = require('../api/youtube');
const vercelConfig = require('../vercel.json');

const app = express();
const bindHost = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');

const JOB_LIMIT_PER_HOUR = 10;
const JOB_WINDOW_MS = 60 * 60 * 1000;
const MAX_PENDING_JOBS = 25;
const DOWNLOAD_LIMIT_PER_HOUR = 5;
const DOWNLOAD_WINDOW_MS = 60 * 60 * 1000;
const jobRateStore = new Map();
const downloadRateStore = new Map();
const allowedAudioExtensions = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.webm']);

const upload = multer({
  storage: multer.diskStorage({
    destination: tmpDir,
    filename: (_req, file, callback) => {
      callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, allowedAudioExtensions.has(extension));
  },
});

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Mismas cabeceras de seguridad que en Vercel (vercel.json es la única fuente). En local se sirve por
// http, así que se quita upgrade-insecure-requests.
const securityHeaders = vercelConfig.headers.find((rule) => rule.source === '/(.*)').headers;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((_req, res, next) => {
  for (const { key, value } of securityHeaders) {
    res.setHeader(key, value.replace(/;\s*upgrade-insecure-requests/, ''));
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.all('/api/youtube', (req, res) => youtubeHandler(req, res));
app.use(morgan('dev'));
app.use(express.static(path.join(rootDir, 'public'), { dotfiles: 'deny' }));

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function canCreateJob(ip) {
  const now = Date.now();
  const start = now - JOB_WINDOW_MS;
  const attempts = (jobRateStore.get(ip) || []).filter((ts) => ts > start);

  if (attempts.length >= JOB_LIMIT_PER_HOUR) {
    const retryAfterSeconds = Math.max(1, Math.ceil((attempts[0] + JOB_WINDOW_MS - now) / 1000));
    jobRateStore.set(ip, attempts);
    return { allowed: false, retryAfterSeconds };
  }

  attempts.push(now);
  jobRateStore.set(ip, attempts);
  return { allowed: true, retryAfterSeconds: 0 };
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

function buildQueuedJob({ inputPath, originalFileName, tuningMode, targetA4 }) {
  return {
    id: randomUUID(),
    sourceType: 'upload',
    originalFileName,
    inputPath,
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
}

async function enqueueJob(job) {
  await createJob(job);
  queue.add({ jobId: job.id, inputPath: job.inputPath, targetA4: job.targetA4 });
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
  const { jobId, inputPath, targetA4 } = payload;

  const startedAt = nowIso();
  await updateJob(jobId, {
    status: 'retuning',
    startedAt,
  });

  try {
    await updateJob(jobId, { status: 'retuning' });
    const outputs = await convertTo432Hz({ inputPath, jobId, targetA4 });

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

app.post('/api/jobs', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Debes seleccionar un archivo de audio compatible.' });
    return;
  }

  const requestedMode = typeof req.body.tuningMode === 'string' ? req.body.tuningMode : 'exact';
  const tuningMode = requestedMode in tuningProfiles ? requestedMode : 'exact';
  const targetA4 = tuningProfiles[tuningMode];
  const clientIp = getClientIp(req);

  const rate = canCreateJob(clientIp);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({ error: 'Limite alcanzado: maximo 10 trabajos por hora.' });
    return;
  }

  if (queue.getPendingCount() >= MAX_PENDING_JOBS) {
    await fs.rm(req.file.path, { force: true });
    res.status(503).json({ error: 'La cola esta llena. Intenta de nuevo en unos minutos.' });
    return;
  }

  try {
    await assertAudioConstraints(req.file.path);
  } catch (error) {
    await fs.rm(req.file.path, { force: true });
    res.status(400).json({ error: error.message });
    return;
  }

  const job = buildQueuedJob({
    inputPath: req.file.path,
    originalFileName: req.file.originalname,
    tuningMode,
    targetA4,
  });
  await enqueueJob(job);

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
    sourceType: job.sourceType,
    originalFileName: job.originalFileName,
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

app.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: `El archivo supera el limite de ${Math.round(maxUploadBytes / (1024 * 1024))} MB.` });
    return;
  }

  if (error?.message === 'Unexpected field') {
    res.status(400).json({ error: 'El formulario debe incluir un unico archivo de audio.' });
    return;
  }

  if (error) {
    res.status(400).json({ error: error.message || 'No se pudo recibir el archivo.' });
    return;
  }

  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

async function start() {
  await fs.mkdir(tmpDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, bindHost, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      console.log(`cooler listening on http://${bindHost}:${actualPort}`);
      resolve(server);
    });

    server.once('error', reject);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Unable to start server:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, start };
