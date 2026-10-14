import Fastify, { FastifyInstance } from 'fastify';
import { Solver } from './solver';
import {
  JobManager, QueueFullError, TokenAuth, envInteger, jobManagerOptionsFromEnv, projectJob,
} from './job_manager';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Digest of the installed `bim-engine/v1` contract this engine pins in its OpenAPI (see README). */
export const PROTOCOL_DIGEST = 'sha256-1de9afb5af0d4ea913c5c0e6e24948cc76a58ebcd7edc54a53e68a5a2f761563';

export interface ServerOptions {
  jobs?: JobManager;
  auth?: TokenAuth;
  env?: NodeJS.ProcessEnv;
  /** Added to `time_budget_ms` to bound the whole execution of a job. */
  timeoutGraceMs?: number;
}

export function buildServer(
  solver: Pick<Solver, 'validate' | 'solve'> = new Solver(),
  options: ServerOptions = {},
): FastifyInstance {
  const env = options.env ?? process.env;
  const auth = options.auth ?? new TokenAuth(env.ENGINE_AUTH_TOKENS);
  const jobs = options.jobs ?? new JobManager(jobManagerOptionsFromEnv(env));
  const timeoutGraceMs = options.timeoutGraceMs ?? envInteger(env, 'ENGINE_TIMEOUT_GRACE_MS', 15_000, 0, 3_600_000);
  const openapi = engineOpenApi(auth.enabled);

  const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES });
  // DELETE and GET callers (the gateway among them) send `content-type: application/json` with no body.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : String(body);
    if (text.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      (error as any).statusCode = 400;
      done(error as Error, undefined);
    }
  });
  app.setErrorHandler((error: any, _request, reply) => {
    const code = Number(error?.statusCode);
    const status = code === 413 ? 413 : code === 400 ? 400 : 500;
    return problem(reply, status, status === 413 ? 'Request body exceeds 64 MiB'
      : status === 400 ? `Malformed request: ${String(error?.message || error)}`
      : `Engine transport failed: ${String(error?.message || error)}`);
  });
  app.addHook('onClose', async () => {
    await jobs.shutdown();
  });

  /** The caller's tenant, or `null` after answering 401. */
  const tenantOf = (request: any, reply: any): string | null => {
    const tenant = auth.authenticate(request.headers.authorization);
    if (tenant === null) {
      reply.header('www-authenticate', 'Bearer');
      problem(reply, 401, 'A valid bearer token is required');
    }
    return tenant;
  };

  // Open: the orchestrator's liveness probe carries no credentials.
  app.get('/health', async () => ({ status: 'ok' }));
  // The same answer behind the bearer token, for registrations that map `health` with authentication.
  app.get('/internal/v1/health', async (request, reply) => {
    if (tenantOf(request, reply) === null) return reply;
    return { status: 'ok' };
  });
  app.get('/openapi.json', async () => openapi);

  app.post('/internal/v1/binding-problems', async (request, reply) => {
    const tenant = tenantOf(request, reply);
    if (tenant === null) return reply;
    let body: any;
    try {
      body = request.body as any;
      requireEnvelope(body);
      // Validate synchronously so unsupported IR/options produce 422 instead
      // of a queued job that later fails after silently changing semantics.
      solver.validate(body.problem, body.options || {}, body.optimization);
    } catch (error) {
      return problem(reply, 422, String((error as Error)?.message || error));
    }
    try {
      const solverOptions = body.options || {};
      const budgetMs = solverOptions.time_budget_ms == null ? 30000 : Number(solverOptions.time_budget_ms);
      // Every POST is a new job with a new id. X-Openbinding-Job-Id / -Attempt are not used to
      // deduplicate (idScope "attempt"): a resubmission never reopens or joins an earlier job.
      const job = jobs.submit(
        tenant,
        (signal) => solver.solve(body.problem, solverOptions, body.optimization, signal),
        { timeoutMs: Math.round(budgetMs) + timeoutGraceMs },
      );
      return reply.code(202).send({ id: job.id, status: 'queued' });
    } catch (error) {
      if (error instanceof QueueFullError) {
        reply.header('retry-after', '1');
        return problem(reply, 503, error.message);
      }
      return problem(reply, 500, `Engine failed to accept the job: ${String((error as Error)?.message || error)}`);
    }
  });

  app.get('/internal/v1/jobs/:id', async (request, reply) => {
    const tenant = tenantOf(request, reply);
    if (tenant === null) return reply;
    const { id } = request.params as { id: string };
    const job = jobs.get(id, tenant);
    // A job of another tenant and a job that does not exist are the same 404.
    if (!job) return problem(reply, 404, 'Engine job not found');
    return reply.send(projectJob(job));
  });

  // Extension of bim-engine/v1 (the contract has no DELETE), declared per registration through
  // `spec.extensions.cancellation`. 200: the job is over (cancelled, or it had already completed or
  // failed); 202: the solver has not been confirmed gone yet (`cancelling`); 404: unknown or not yours.
  app.delete('/internal/v1/jobs/:id', async (request, reply) => {
    const tenant = tenantOf(request, reply);
    if (tenant === null) return reply;
    const { id } = request.params as { id: string };
    const outcome = await jobs.cancel(id, tenant);
    if (outcome.kind === 'not_found') return problem(reply, 404, 'Engine job not found');
    if (outcome.kind === 'final') return reply.code(200).send({ id, status: outcome.job.status });
    reply.header('retry-after', '1');
    return reply.code(202).send({ id, status: 'cancelling' });
  });
  return app;
}

function requireEnvelope(body: any): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('BindingProblemRequest must be an object');
  }
  const unknown = Object.keys(body).filter((key) => !['apiVersion', 'kind', 'protocol', 'problem', 'optimization', 'options'].includes(key));
  if (unknown.length) throw new Error(`BindingProblemRequest has unknown fields: ${unknown.join(', ')}`);
  if (body.apiVersion !== 'bim/v1' || body.kind !== 'BindingProblemRequest'
      || body.protocol !== 'bim-engine/v1' || !body.problem || !body.optimization) {
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

const PROBLEM_RESPONSE = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

/**
 * The deployment OpenAPI of this engine: the schemas of `bim-engine/v1` (asynchronous mode) plus the
 * optional DELETE of the job resource that implements cancellation. A registration that maps this
 * document and declares `spec.extensions.cancellation = {supported: true, idScope: "attempt"}` lets the
 * gateway cancel; without the DELETE described here the gateway turns the capability off.
 */
export function engineOpenApi(bearer: boolean): Record<string, unknown> {
  const security = bearer ? [{ bearerAuth: [] }] : undefined;
  const secured = (operation: Record<string, unknown>) => (security ? { ...operation, security } : operation);
  const unauthorized = bearer ? { '401': PROBLEM_RESPONSE('A valid bearer token is required.') } : {};
  const idParameter = [{ in: 'path', name: 'id', required: true, schema: { type: 'string', minLength: 1 } }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'MiniZinc exact BIM engine',
      version: '1.1.0',
      description: 'Asynchronous bim-engine/v1 engine with best-effort job cancellation (DELETE on the job resource).',
    },
    'x-bim-protocol': 'bim-engine/v1',
    'x-bim-protocol-digest': PROTOCOL_DIGEST,
    paths: {
      '/internal/v1/binding-problems': {
        post: secured({
          summary: 'Solve a canonical BIM v1 BindingProblem IR.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BindingProblemRequest' } } },
          },
          responses: {
            '202': {
              description: 'The engine accepted the immutable IR for asynchronous execution.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/EngineJobAccepted' } } },
            },
            ...unauthorized,
            '422': PROBLEM_RESPONSE('The IR or requested options are not supported by this engine mode.'),
            '413': PROBLEM_RESPONSE('The request body exceeds the engine transport limit.'),
            '500': PROBLEM_RESPONSE('The engine failed while accepting the request.'),
            '503': PROBLEM_RESPONSE('The engine queue is full; retry later.'),
          },
        }),
      },
      '/internal/v1/jobs/{id}': {
        get: secured({
          summary: 'Read an asynchronous engine job.',
          parameters: idParameter,
          responses: {
            '200': {
              description: 'Current engine job state. A cancelled job reads as failed with an error starting "cancelled:".',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/EngineJob' } } },
            },
            ...unauthorized,
            '404': PROBLEM_RESPONSE('The engine job does not exist (or belongs to another caller).'),
          },
        }),
        delete: secured({
          summary: 'Cancel an engine job (extension; idempotent).',
          description: 'The solver process group is terminated and reaped before the job is reported cancelled. '
            + '200: the job is over; 202: cancelling, not yet confirmed; 404: unknown or not owned by the caller.',
          parameters: idParameter,
          responses: {
            '200': {
              description: 'The job is over: cancelled, or it had already completed or failed.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/EngineJobCancelReceipt' } } },
            },
            '202': {
              description: 'The cancellation is in progress; the solver has not been confirmed gone yet.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/EngineJobCancelReceipt' } } },
            },
            ...unauthorized,
            '404': PROBLEM_RESPONSE('The engine job does not exist (or belongs to another caller).'),
          },
        }),
      },
      '/internal/v1/health': {
        get: secured({
          summary: 'Engine readiness (authenticated when tokens are configured).',
          responses: { '200': { description: 'Engine is ready.' }, ...unauthorized },
        }),
      },
      '/health': {
        get: {
          summary: 'Liveness probe for the orchestrator; never authenticated.',
          security: [],
          responses: { '200': { description: 'Engine is up.' } },
        },
      },
    },
    components: {
      ...(bearer ? { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } : {}),
      schemas: {
        Ref: {
          type: 'object', additionalProperties: false, required: ['resource', 'id'],
          properties: { resource: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 } },
        },
        BindingProblem: { $ref: './bim/v1/binding-problem.schema.json' },
        BindingProblemRequest: {
          type: 'object', additionalProperties: false,
          required: ['apiVersion', 'kind', 'protocol', 'problem', 'optimization'],
          properties: {
            apiVersion: { const: 'bim/v1' },
            kind: { const: 'BindingProblemRequest' },
            protocol: { const: 'bim-engine/v1' },
            problem: { $ref: '#/components/schemas/BindingProblem' },
            optimization: { $ref: '#/components/schemas/ExecutionOptimization' },
            options: { type: 'object' },
          },
        },
        ExecutionOptimization: {
          type: 'object', additionalProperties: false, required: ['type', 'scalarization', 'weights'],
          properties: {
            type: { type: 'string', enum: ['SINGLE', 'MULTI', 'MANY'] },
            scalarization: { type: 'string', minLength: 1 },
            weights: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false, required: ['criteria', 'value'],
                properties: {
                  criteria: { type: 'string', minLength: 1 },
                  value: { type: 'number', exclusiveMinimum: 0 },
                },
              },
            },
          },
        },
        BindingDecision: {
          type: 'object', additionalProperties: false, required: ['kind', 'binding'],
          properties: {
            kind: { const: 'binding' },
            binding: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Ref' } },
          },
        },
        Violation: {
          type: 'object', additionalProperties: false, required: ['constraint', 'enforcement', 'penalty'],
          properties: {
            constraint: { $ref: '#/components/schemas/Ref' },
            enforcement: { type: 'string', enum: ['hard', 'soft'] },
            penalty: { type: 'number', minimum: 0 },
            message: { type: 'string' },
          },
        },
        ObjectiveComponent: {
          type: 'object', additionalProperties: false, required: ['criteria', 'feature', 'value', 'loss', 'weight'],
          properties: {
            criteria: { type: 'string', minLength: 1 },
            feature: { $ref: '#/components/schemas/Ref' },
            value: { type: 'number' },
            loss: { type: 'number' },
            weight: { type: 'number', minimum: 0 },
          },
        },
        ObjectiveEvaluation: {
          type: 'object', additionalProperties: false,
          required: ['type', 'scalarization', 'components', 'penalty', 'score'],
          properties: {
            type: { type: 'string', enum: ['SINGLE', 'MULTI', 'MANY'] },
            scalarization: { type: 'string', minLength: 1 },
            components: { type: 'array', items: { $ref: '#/components/schemas/ObjectiveComponent' } },
            penalty: { type: 'number', minimum: 0 },
            score: { oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }] },
          },
        },
        BindingSolution: {
          type: 'object', additionalProperties: false,
          required: ['decision', 'features', 'objectives', 'penalties', 'violations'],
          properties: {
            decision: { $ref: '#/components/schemas/BindingDecision' },
            features: { type: 'object', additionalProperties: { type: 'number' } },
            objectives: { $ref: '#/components/schemas/ObjectiveEvaluation' },
            penalties: { type: 'array', items: { type: 'number', minimum: 0 } },
            violations: { type: 'array', items: { $ref: '#/components/schemas/Violation' } },
          },
        },
        BindingResult: {
          type: 'object', additionalProperties: false, required: ['termination', 'solutions'],
          properties: {
            termination: { type: 'string', enum: ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN'] },
            solutions: { type: 'array', items: { $ref: '#/components/schemas/BindingSolution' } },
            provenance: { type: 'object' },
          },
        },
        EngineJobAccepted: {
          type: 'object', additionalProperties: false, required: ['id', 'status'],
          properties: { id: { type: 'string', minLength: 1 }, status: { const: 'queued' } },
        },
        EngineJob: {
          type: 'object', additionalProperties: false, required: ['id', 'status', 'created_at'],
          properties: {
            id: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed'] },
            created_at: { type: 'integer', minimum: 0 },
            result: { $ref: '#/components/schemas/BindingResult' },
            error: { type: 'string' },
          },
          oneOf: [
            {
              properties: { status: { enum: ['queued', 'running'] } },
              not: { anyOf: [{ required: ['result'] }, { required: ['error'] }] },
            },
            { properties: { status: { const: 'completed' } }, required: ['result'], not: { required: ['error'] } },
            { properties: { status: { const: 'failed' } }, required: ['error'], not: { required: ['result'] } },
          ],
        },
        EngineJobCancelReceipt: {
          type: 'object', additionalProperties: false, required: ['id', 'status'],
          properties: {
            id: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['cancelled', 'completed', 'failed', 'cancelling'] },
          },
        },
        Problem: {
          type: 'object', required: ['type', 'title', 'status', 'detail'],
          properties: {
            type: { type: 'string', format: 'uri-reference' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
          },
        },
      },
    },
  };
}

async function start() {
  const app = buildServer();
  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: '0.0.0.0' });
  // Stop the solvers (and so release their CPU) before leaving.
  const shutdown = () => {
    app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) {
  start().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
