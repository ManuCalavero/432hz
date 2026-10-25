// Textos generados desde JavaScript (los textos fijos están en index.html).
const messages = {
  youtubeVideo: 'YouTube video',
  pasteDenied: "Couldn't read the clipboard. Paste the link manually.",
  status: {
    preparing: 'Preparing the YouTube download…',
    checking: "Checking you're not a bot…",
    downloading: 'Downloading audio from YouTube…',
    receiving: 'Receiving audio…',
    loadingEngine: 'Loading the audio engine…',
    converting: 'Retuning to {hz} Hz…',
    preview: 'Preparing the comparison…',
    wav: 'Creating WAV…',
    done: 'Done.',
    error: 'Something went wrong',
  },
  remaining: '{n} YouTube conversions left today.',
  remainingOne: '1 YouTube conversion left today.',
  ab: { play: 'Listen', pause: 'Pause' },
  history: { youtube: 'YouTube', file: 'File', reuse: 'Use link' },
  errors: {
    empty: 'Paste a YouTube link.',
    invalid_url: 'Paste a valid YouTube video link.',
    too_long: 'The audio is longer than {min} minutes.',
    convert_failed: "Couldn't convert the audio. Is it a valid audio file?",
    slow: 'The download is taking too long. Please try again.',
    bad_response: 'Invalid server response.',
    audio_too_big: 'The audio is too large.',
    captcha: "Couldn't verify you're not a bot. Please try again.",
    captcha_unavailable: 'Bot protection is unavailable. Please try again later.',
    user_limit: "You've used today's 5 YouTube conversions. Come back tomorrow.",
    global_limit: "Today's YouTube limit has been reached. Come back tomorrow.",
    not_configured: 'YouTube conversion is not available right now.',
    quota_exhausted: 'YouTube conversion has reached its usage limit. Please try again later.',
    upstream: "Couldn't reach the download service.",
    download_failed: "Couldn't download the audio from this video.",
    video_unavailable: "Couldn't download this video (it may be private or age-restricted).",
    expired_job: 'The download expired. Paste the link again.',
    unexpected: 'Unexpected error. Please try again.',
  },
};

export const lang = 'en';
export const locale = 'en-GB';

export function t(path, params = {}) {
  const value = path.split('.').reduce((node, key) => node?.[key], messages);
  if (typeof value !== 'string') {
    return path.startsWith('errors.') ? messages.errors.unexpected : path;
  }
  return value.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''));
}

// Error con código traducible (los códigos coinciden con los que devuelve /api/youtube).
export class AppError extends Error {
  constructor(code, params) {
    super(t(`errors.${code}`, params));
    this.code = code;
  }
}
