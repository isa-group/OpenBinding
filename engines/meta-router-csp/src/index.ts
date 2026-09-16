import Fastify, { FastifyInstance } from 'fastify';
import { MetaRoutingSolver, RoutingRequest } from './solver';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export function buildServer(solver = new MetaRoutingSolver()): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES });

  app.get('/health', async () => ({
    status: 'ok',
    engine: 'meta-router-csp',
    version: '1.0.0',
  }));

  app.post('/route', async (request, reply) => {
    try {
      const body = request.body as RoutingRequest;
      const result = solver.solve(body);
      return reply.code(200).send(result);
    } catch (error) {
      return reply.code(422).send({
        status: 422,
        error: String((error as Error)?.message || error),
      });
    }
  });

  app.post('/internal/v1/meta-route', async (request, reply) => {
    try {
      const body = request.body as RoutingRequest;
      const result = solver.solve(body);
      return reply.code(200).send(result);
    } catch (error) {
      return reply.code(422).send({
        status: 422,
        error: String((error as Error)?.message || error),
      });
    }
  });

  app.post('/internal/v1/binding-problems', async (request, reply) => {
    try {
      const body = request.body as any;
      const routingRequest = (body?.options?.routingRequest || body) as RoutingRequest;
      const result = solver.solve(routingRequest);
      return reply.code(200).send({
        apiVersion: 'bim/v1',
        kind: 'BindingProblemResponse',
        status: 'completed',
        result,
      });
    } catch (error) {
      return reply.code(422).send({
        status: 422,
        error: String((error as Error)?.message || error),
      });
    }
  });

  return app;
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
