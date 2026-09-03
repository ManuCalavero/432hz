const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
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

function resolveFfmpegPath() {
  const packagedMarker = `${path.sep}app.asar${path.sep}`;
  if (ffmpegPath.includes(packagedMarker)) {
    return ffmpegPath.replace(packagedMarker, `${path.sep}app.asar.unpacked${path.sep}`);
  }

  return ffmpegPath;
}

async function ensureFolders() {
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

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

async function inspectInputAudio(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), ['-hide_banner', '-i', inputPath], {
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
        reject(new Error('El archivo no contiene un audio compatible.'));
        return;
      }

      const sampleRate = Number(match[1]);
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        reject(new Error('Sample rate de entrada invalido.'));
        return;
      }

      const durationMatch = stderr.match(/Duration:\s(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i);
      const durationSeconds = durationMatch
        ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
        : null;

      resolve({ sampleRate, durationSeconds });
    });
  });
}

async function assertAudioConstraints(inputPath) {
  const info = await inspectInputAudio(inputPath);

  if (Number.isFinite(info.durationSeconds) && info.durationSeconds > maxAudioSeconds) {
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

async function convertTo432Hz({ inputPath, jobId, targetA4 }) {
  await ensureFolders();

  const wavPath = path.join(outputDir, `${jobId}.wav`);
  const mp3Path = path.join(outputDir, `${jobId}.mp3`);

  try {
    const { sampleRate: inputSampleRate } = await inspectInputAudio(inputPath);
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

    return {
      wavPath,
      mp3Path,
      appliedTargetA4: safeTargetA4,
    };
  } finally {
    await fsp.rm(inputPath, { force: true });
  }
}

module.exports = {
  assertAudioConstraints,
  convertTo432Hz,
};
