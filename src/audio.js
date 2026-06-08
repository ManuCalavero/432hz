const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const {
  tmpDir,
  outputDir,
  outputSampleRate,
  outputWavSampleFormat,
  outputMp3Bitrate,
  maxAudioSeconds,
  referenceA4,
  defaultTargetA4,
} = require('./config');

async function ensureFolders() {
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

function isYouTubeUrl(url) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(url);
}

function normalizeYouTubeUrl(inputUrl) {
  let parsed;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return inputUrl;
  }

  const host = parsed.hostname.toLowerCase();

  if (host.includes('youtu.be')) {
    const videoId = parsed.pathname.replace(/^\//, '').split('/')[0];
    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return inputUrl;
  }

  if (!host.includes('youtube.com')) {
    return inputUrl;
  }

  const videoId = parsed.searchParams.get('v');
  if (videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  return inputUrl;
}

function resolveYtDlpAuthOptions() {
  const cookiesFromBrowser = (process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim();
  const cookiesFile = (process.env.YTDLP_COOKIES_FILE || '').trim();

  if (cookiesFromBrowser) {
    return { cookiesFromBrowser };
  }

  if (cookiesFile) {
    return { cookies: path.resolve(cookiesFile) };
  }

  return {};
}

function baseYtDlpOptions() {
  return {
    noWarnings: true,
    noPlaylist: true,
    noCheckCertificates: true,
    ...resolveYtDlpAuthOptions(),
  };
}

function mapYtDlpError(error) {
  const raw = String(error?.stderr || error?.message || error || '');

  if (/Sign in to confirm you.?re not a bot/i.test(raw)) {
    return new Error(
      'YouTube ha bloqueado la descarga por verificacion anti-bot. ' +
        'Configura YTDLP_COOKIES_FROM_BROWSER (ej: chrome) o YTDLP_COOKIES_FILE ' +
        'en el entorno del servidor para permitir descargas en produccion.'
    );
  }

  if (/Requested format is not available/i.test(raw)) {
    return new Error(
      'YouTube no ofrece el formato solicitado para este video en este entorno. ' +
        'La app ha intentado varios formatos automaticamente, pero no se encontro uno valido.'
    );
  }

  return error;
}

async function getVideoInfo(url) {
  let result;
  try {
    result = await youtubedl(url, {
      ...baseYtDlpOptions(),
      dumpSingleJson: true,
      skipDownload: true,
      preferFreeFormats: true,
    });
  } catch (error) {
    throw mapYtDlpError(error);
  }

  if (typeof result === 'string') {
    return JSON.parse(result);
  }

  return result;
}

async function downloadAudio(url, jobId) {
  const outputTemplate = path.join(tmpDir, `${jobId}-input.%(ext)s`);
  const formatFallbacks = ['bestaudio/best', 'bestaudio', 'bestaudio*', 'ba', 'best'];
  let lastError = null;

  for (const formatSelector of formatFallbacks) {
    try {
      await youtubedl(url, {
        ...baseYtDlpOptions(),
        format: formatSelector,
        output: outputTemplate,
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw mapYtDlpError(lastError);
  }

  const files = await fsp.readdir(tmpDir);
  const matches = files
    .filter((fileName) => fileName.startsWith(`${jobId}-input.`))
    .map((fileName) => path.join(tmpDir, fileName));

  if (matches.length === 0) {
    throw new Error('No se pudo descargar el audio desde YouTube.');
  }

  return matches[0];
}

async function detectInputSampleRate(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', () => {
      const match = stderr.match(/Audio:\s[^\n]*?,\s(\d+)\sHz/i);
      if (!match) {
        reject(new Error('No se pudo detectar el sample rate del audio de entrada.'));
        return;
      }

      const sampleRate = Number(match[1]);
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        reject(new Error('Sample rate de entrada invalido.'));
        return;
      }

      resolve(sampleRate);
    });
  });
}

async function assertVideoConstraints(url) {
  if (!isYouTubeUrl(url)) {
    throw new Error('La URL no es un enlace valido de YouTube.');
  }

  const info = await getVideoInfo(url);
  const seconds = Number(info.duration || 0);

  if (Number.isFinite(seconds) && seconds > maxAudioSeconds) {
    throw new Error(`El audio supera el limite de ${Math.round(maxAudioSeconds / 60)} minutos.`);
  }

  return info;
}

function resolveTargetA4(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return defaultTargetA4;
  }

  if (numeric < 420 || numeric > referenceA4) {
    return defaultTargetA4;
  }

  return numeric;
}

async function exportWavWithPitch({ inputPath, wavPath, ratio, tempoFix, inputSampleRate }) {
  const soxrFilter =
    `asetrate=${inputSampleRate}*${ratio},` +
    `aresample=${inputSampleRate}:resampler=soxr:precision=28:cheby=1,` +
    `atempo=${tempoFix}`;

  const fallbackFilter =
    `asetrate=${inputSampleRate}*${ratio},` +
    `aresample=${inputSampleRate},` +
    `atempo=${tempoFix}`;

  const buildArgs = (filterValue) => [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '2',
    '-ar',
    String(outputSampleRate),
    '-sample_fmt',
    outputWavSampleFormat,
    '-af',
    filterValue,
    wavPath,
  ];

  try {
    await runFfmpeg(buildArgs(soxrFilter));
    return;
  } catch (firstError) {
    try {
      await runFfmpeg(buildArgs(fallbackFilter));
      return;
    } catch (fallbackError) {
      const combinedMessage =
        `Primary resampler failed:\n${String(firstError.message)}\n\n` +
        `Fallback resampler failed:\n${String(fallbackError.message)}`;
      throw new Error(combinedMessage);
    }
  }
}

async function exportWavWithoutPitch({ inputPath, wavPath }) {
  await runFfmpeg([
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '2',
    '-ar',
    String(outputSampleRate),
    '-sample_fmt',
    outputWavSampleFormat,
    wavPath,
  ]);
}

async function convertTo432Hz({ url, jobId, targetA4 }) {
  await ensureFolders();

  const wavPath = path.join(outputDir, `${jobId}.wav`);
  const mp3Path = path.join(outputDir, `${jobId}.mp3`);

  const inputPath = await downloadAudio(url, jobId);
  const inputSampleRate = await detectInputSampleRate(inputPath);

  const safeTargetA4 = resolveTargetA4(targetA4);
  const ratio = safeTargetA4 / referenceA4;
  const tempoFix = referenceA4 / safeTargetA4;

  if (safeTargetA4 === referenceA4) {
    await exportWavWithoutPitch({ inputPath, wavPath });
  } else {
    await exportWavWithPitch({ inputPath, wavPath, ratio, tempoFix, inputSampleRate });
  }

  await runFfmpeg([
    '-y',
    '-i',
    wavPath,
    '-codec:a',
    'libmp3lame',
    '-b:a',
    outputMp3Bitrate,
    '-ar',
    String(outputSampleRate),
    mp3Path,
  ]);

  await fsp.rm(inputPath, { force: true });

  return {
    wavPath,
    mp3Path,
    appliedTargetA4: safeTargetA4,
  };
}

module.exports = {
  normalizeYouTubeUrl,
  assertVideoConstraints,
  convertTo432Hz,
};
