const jobs = new Map();

async function createJob(job) {
  jobs.set(job.id, job);
  return job;
}

async function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) {
    return null;
  }

  const updatedJob = {
    ...job,
    ...patch,
  };
  jobs.set(jobId, updatedJob);
  return updatedJob;
}

async function getJob(jobId) {
  return jobs.get(jobId) || null;
}

module.exports = {
  createJob,
  updateJob,
  getJob,
};
