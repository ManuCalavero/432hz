const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_ROOT = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : ROOT_DIR;

module.exports = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  rootDir: ROOT_DIR,
  tmpDir: path.join(DATA_ROOT, 'storage', 'tmp'),
  outputDir: path.join(DATA_ROOT, 'storage', 'output'),
  maxUploadBytes: 250 * 1024 * 1024,
  outputSampleRate: 44100,
  outputWavSampleFormat: 's16',
  outputMp3Bitrate: '320k',
  maxAudioSeconds: 60 * 60,
  referenceA4: 440,
  defaultTargetA4: 432,
  tuningProfiles: {
    original: 440,
    exact: 432,
  },
};
