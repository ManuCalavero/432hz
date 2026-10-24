// Prueba manual: descarga audio de YouTube con Apify y lo convierte a 432 Hz.
// Uso: node scripts/apify-test.js <link1> [link2] ...
require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const { tmpDir } = require('../src/config');
const { convertTo432Hz } = require('../src/audio');

const API = 'https://api.apify.com/v2';
const ACTOR = 'utils~youtube-link';
const MAX_LINKS = 5;
const token = process.env.APIFY_TOKEN;

async function apify(pathname, options = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Apify ${response.status}: ${JSON.stringify(body?.error || body)}`);
  }
  return body.data ?? body;
}

async function waitForRun(runId) {
  for (;;) {
    const run = await apify(`/actor-runs/${runId}?waitForFinish=60`);
    console.log(`  estado: ${run.status}`);
    if (!['READY', 'RUNNING'].includes(run.status)) {
      return run;
    }
  }
}

async function downloadFile(url, filePath) {
  const headers = url.startsWith(API) ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Descarga ${response.status}`);
  }
  await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
}

async function main() {
  if (!token) {
    throw new Error('Falta APIFY_TOKEN en .env');
  }

  const links = process.argv.slice(2);
  if (links.length === 0 || links.length > MAX_LINKS) {
    throw new Error(`Pasa entre 1 y ${MAX_LINKS} links: node scripts/apify-test.js <link1> [link2] ...`);
  }

  const startedAt = Date.now();
  console.log(`Lanzando ${ACTOR} con ${links.length} link(s)...`);
  const started = await apify(`/acts/${ACTOR}/runs`, {
    method: 'POST',
    body: JSON.stringify({ videos: links.map((url) => ({ url })), audioQuality: 'best' }),
  });

  const run = await waitForRun(started.id);
  const items = await apify(`/datasets/${run.defaultDatasetId}/items?clean=true`);
  console.log(`Apify terminó en ${((Date.now() - startedAt) / 1000).toFixed(1)} s\n`);

  await fs.mkdir(tmpDir, { recursive: true });

  for (const item of items) {
    console.log(`• ${item.title || item.url}`);
    if (!item.ok || !item.downloadUrl) {
      console.log(`  ✗ Falló en Apify: ${item.error || 'sin downloadUrl'}\n`);
      continue;
    }

    try {
      const inputPath = path.join(tmpDir, `apify-${Date.now()}${path.extname(item.filename || '.m4a')}`);
      await downloadFile(item.downloadUrl, inputPath);
      console.log(`  ✓ Audio descargado (${((item.bytes || 0) / (1024 * 1024)).toFixed(1)} MB, ${item.seconds ?? '?'} s)`);

      const outputs = await convertTo432Hz({ inputPath, jobId: `apify-test-${Date.now()}`, targetA4: 432 });
      console.log(`  ✓ Convertido a 432 Hz: ${outputs.mp3Path}\n`);
    } catch (error) {
      console.log(`  ✗ Error: ${error.message.split('\n')[0]}\n`);
    }
  }

  const finalRun = await apify(`/actor-runs/${run.id}`);
  const ok = items.filter((item) => item.ok).length;
  console.log(`Resultado: ${ok}/${items.length} correctos`);
  console.log(`Coste de esta ejecución: ${finalRun.usageTotalUsd != null ? `${finalRun.usageTotalUsd.toFixed(4)} $` : 'mira el panel de Apify'}`);
  if (finalRun.chargedEventCounts) {
    console.log(`Eventos cobrados: ${JSON.stringify(finalRun.chargedEventCounts)}`);
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
