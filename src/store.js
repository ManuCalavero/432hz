const fs = require('fs/promises');
const path = require('path');
const { dataFile } = require('./config');

async function ensureStore() {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });

  try {
    await fs.access(dataFile);
  } catch {
    const initial = { jobs: [] };
    await fs.writeFile(dataFile, JSON.stringify(initial, null, 2), 'utf8');
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(dataFile, 'utf8');
  return JSON.parse(raw);
}

async function writeStore(data) {
  await fs.writeFile(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

async function createJob(job) {
  const db = await readStore();
  db.jobs.unshift(job);
  await writeStore(db);
  return job;
}

async function updateJob(jobId, patch) {
  const db = await readStore();
  const jobIndex = db.jobs.findIndex((item) => item.id === jobId);

  if (jobIndex === -1) {
    return null;
  }

  db.jobs[jobIndex] = {
    ...db.jobs[jobIndex],
    ...patch,
  };

  await writeStore(db);
  return db.jobs[jobIndex];
}

async function getJob(jobId) {
  const db = await readStore();
  return db.jobs.find((item) => item.id === jobId) || null;
}

async function getJobs() {
  const db = await readStore();
  return db.jobs;
}

module.exports = {
  ensureStore,
  createJob,
  updateJob,
  getJob,
  getJobs,
};
