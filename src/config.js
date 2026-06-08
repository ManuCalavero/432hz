const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

module.exports = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  rootDir: ROOT_DIR,
  dataFile: path.join(ROOT_DIR, 'data', 'jobs.json'),
  tmpDir: path.join(ROOT_DIR, 'storage', 'tmp'),
  outputDir: path.join(ROOT_DIR, 'storage', 'output'),
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
