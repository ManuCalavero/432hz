class InMemoryQueue {
  constructor(worker) {
    this.worker = worker;
    this.pending = [];
    this.isRunning = false;
  }

  add(payload) {
    this.pending.push(payload);
    this.run().catch((error) => {
      console.error('Queue fatal error:', error);
    });
  }

  async run() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    while (this.pending.length > 0) {
      const next = this.pending.shift();
      try {
        await this.worker(next);
      } catch (error) {
        console.error('Queue worker error:', error);
      }
    }

    this.isRunning = false;
  }
}

module.exports = { InMemoryQueue };
