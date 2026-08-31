import Fastify, { FastifyInstance } from 'fastify';
import { Solver } from './solver';
import { JobManager } from './jobs';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function buildServer(solver: Pick<Solver, 'validate' | 'solve'> = new Solver()): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES });
  const jobs = new JobManager();
  app.setErrorHandler((error: any, _request, reply) => {
    const status = Number(error?.statusCode) === 413 ? 413 : 500;
    return problem(reply, status, status === 413 ? 'Request body exceeds 64 MiB'
      : `Engine transport failed: ${String(error?.message || error)}`);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/internal/v1/binding-problems', async (request, reply) => {
    try {
      const body = request.body as any;
      requireEnvelope(body);
      // Validate synchronously so unsupported IR/options produce 422 instead
      // of a queued job that later fails after silently changing semantics.
      solver.validate(body.problem, body.options || {});
      const job = jobs.createJob();
      jobs.updateJob(job.id, { status: 'running' });
      solver.solve(body.problem, body.options || {})
        .then((result) => jobs.updateJob(job.id, { status: 'completed', result }))
        .catch((error) => jobs.updateJob(job.id, { status: 'failed', error: String(error?.message || error) }));
      return reply.code(202).send({ id: job.id, status: 'queued' });
    } catch (error) {
      return problem(reply, 422, String((error as Error)?.message || error));
    }
  });

  app.get('/internal/v1/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = jobs.getJob(id);
    if (!job) return problem(reply, 404, 'Engine job not found');
    return reply.send(job);
  });
  return app;
}

function requireEnvelope(body: any): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('BindingProblemRequest must be an object');
  }
  const unknown = Object.keys(body).filter((key) => !['apiVersion', 'kind', 'protocol', 'problem', 'options'].includes(key));
  if (unknown.length) throw new Error(`BindingProblemRequest has unknown fields: ${unknown.join(', ')}`);
  if (body.apiVersion !== 'bim/v1' || body.kind !== 'BindingProblemRequest'
      || body.protocol !== 'bim-engine/v1' || !body.problem) {
    throw new Error('Expected bim/v1 BindingProblemRequest using bim-engine/v1');
  }
}

function problem(reply: any, status: number, detail: string) {
  return reply.code(status).type('application/problem+json').send({
    type: 'https://bim.dev/problems/engine-request',
    title: status === 422 ? 'Invalid BIM engine request' : 'BIM engine error',
    status,
    detail,
  });
}

async function start() {
  const app = buildServer();
  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

if (require.main === module) {
  start().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
