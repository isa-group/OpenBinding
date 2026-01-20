import Fastify from 'fastify';
import { Solver } from './solver';
import { JobManager } from './jobs';

const fastify = Fastify({ logger: true });
const solver = new Solver();
const jobManager = new JobManager();

fastify.post('/solve', async (request, reply) => {
  const body = request.body as any;
  const instance = body.instance;
  const options = body.options || {};

  const job = jobManager.createJob();

  // Start processing asynchronously
  jobManager.updateJob(job.id, { status: 'running' });
  solver.solve(instance, options)
    .then(result => {
      jobManager.updateJob(job.id, { status: 'completed', result });
    })
    .catch(err => {
      jobManager.updateJob(job.id, { status: 'failed', error: err.message });
    });

  reply.code(202).send({ job_id: job.id, status: 'queued' });
});

fastify.get('/jobs/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const job = jobManager.getJob(id);

  if (!job) {
    reply.code(404).send({ error: 'Job not found' });
    return;
  }

  return job;
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
