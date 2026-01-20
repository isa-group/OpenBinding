export interface Job {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result?: any;
  error?: string;
  created_at: number;
}

export class JobManager {
  private jobs: Map<string, Job> = new Map();

  createJob(): Job {
    const id = Math.random().toString(36).substring(2, 12);
    const job: Job = {
      id,
      status: 'queued',
      created_at: Date.now()
    };
    this.jobs.set(id, job);
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  updateJob(id: string, updates: Partial<Job>) {
    const job = this.jobs.get(id);
    if (job) {
      Object.assign(job, updates);
    }
  }
}
