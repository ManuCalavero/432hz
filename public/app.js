const form = document.getElementById('job-form');
const urlInput = document.getElementById('youtube-url');
const tuningModeInput = document.getElementById('tuning-mode');
const tuningModeButtons = document.querySelectorAll('.tuning-btn');
const formError = document.getElementById('form-error');
const panel = document.getElementById('job-panel');
const statusEl = document.getElementById('job-status');
const tuningEl = document.getElementById('job-tuning');
const durationEl = document.getElementById('job-duration');
const errorEl = document.getElementById('job-error');
const downloadsEl = document.getElementById('downloads');
const logsBody = document.getElementById('logs-body');

let pollTimer = null;
let activeJobId = null;

function formatDurationMs(ms) {
  if (!ms && ms !== 0) {
    return '-';
  }

  if (ms < 1000) {
    return `${ms} ms`;
  }

  return `${(ms / 1000).toFixed(2)} s`;
}

function humanStatus(status) {
  const mapping = {
    queued: 'En cola',
    downloading: 'Descargando audio',
    retuning: 'Retunando afinacion',
    exporting: 'Exportando formatos',
    completed: 'Completado',
    failed: 'Error',
  };

  return mapping[status] || status;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function modeLabel(mode) {
  const modeLabels = {
    original: 'Sin transformación',
    exact: 'Exacto',
  };

  return modeLabels[mode] || '-';
}

function setSelectedTuningMode(mode) {
  tuningModeInput.value = mode;
  tuningModeButtons.forEach((button) => {
    const isSelected = button.dataset.value === mode;
    button.setAttribute('aria-pressed', String(isSelected));
  });
}

tuningModeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const { value } = button.dataset;
    if (value) {
      setSelectedTuningMode(value);
    }
  });
});

setSelectedTuningMode(tuningModeInput.value || 'exact');

function setJobView(job) {
  panel.classList.remove('hidden');
  statusEl.textContent = humanStatus(job.status);
  if (job.targetA4) {
    tuningEl.textContent = `Perfil: ${modeLabel(job.tuningMode)} (${job.targetA4} Hz)`;
  } else {
    tuningEl.textContent = '';
  }
  durationEl.textContent = `Duración operación: ${formatDurationMs(job.durationMs)}`;
  errorEl.textContent = job.error || '';

  if (job.downloads) {
    downloadsEl.innerHTML = `<a href="${job.downloads.wav}">Descargar WAV</a><a href="${job.downloads.mp3}">Descargar MP3</a>`;
  } else {
    downloadsEl.innerHTML = '';
  }
}

async function refreshLogs() {
  const response = await fetch('/api/admin/logs');
  const logs = await response.json();

  logsBody.innerHTML = logs
    .slice(0, 25)
    .map((row) => {
      const startedAt = row.startedAt ? new Date(row.startedAt).toLocaleString() : '-';
      const resultClass = row.result === 'ok' ? 'state-ok' : row.result === 'ko' ? 'state-ko' : '';
      return `<tr>
        <td>${escapeHtml(startedAt)}</td>
        <td><a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">link</a></td>
        <td>${escapeHtml(modeLabel(row.tuningMode))}</td>
        <td>${escapeHtml(row.targetA4 || '-')}</td>
        <td>${escapeHtml(humanStatus(row.status))}</td>
        <td class="${resultClass}">${escapeHtml(row.result || '-')}</td>
        <td>${escapeHtml(formatDurationMs(row.durationMs))}</td>
      </tr>`;
    })
    .join('');
}

async function pollJob(jobId) {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  if (activeJobId !== jobId) {
    return;
  }

  try {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();

    if (!response.ok) {
      throw new Error(job.error || 'No se pudo consultar el trabajo.');
    }

    if (activeJobId !== jobId) {
      return;
    }

    setJobView(job);
    await refreshLogs();

    if (job.status !== 'completed' && job.status !== 'failed') {
      pollTimer = setTimeout(() => pollJob(jobId), 2000);
    }
  } catch (error) {
    errorEl.textContent = error.message;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  formError.classList.add('hidden');
  formError.textContent = '';
  errorEl.textContent = '';

  const url = urlInput.value.trim();
  const tuningMode = tuningModeInput.value;

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, tuningMode }),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'No se pudo crear el trabajo.');
    }

    activeJobId = payload.id;

    setJobView({
      status: payload.status,
      durationMs: null,
      error: null,
      downloads: null,
      tuningMode: payload.tuningMode,
      targetA4: payload.targetA4,
    });
    pollJob(payload.id);
  } catch (error) {
    formError.textContent = error.message;
    formError.classList.remove('hidden');
  }
});

refreshLogs().catch(() => {
  // Ignore initial load errors.
});
