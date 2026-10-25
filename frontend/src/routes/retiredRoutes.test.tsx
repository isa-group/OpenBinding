import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions } from './registry';
import { RETIRED_ROUTES } from './retiredRoutes';

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

describe('the table of retired addresses', () => {
  // [utest->req~frontend-retire-redirect-decision-space~1]
  it.each(RETIRED_ROUTES)('follows one rule for $path', ({ target }) => {
    const to = (query: string) => target(new URLSearchParams(query));
    const study = 'org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds';

    expect(to(`${study}&run=run-1&cell=cell-3`)).toBe('/app/isa-demo/qos-benchmarks/studies/engines-vs-seeds/runs/run-1');
    expect(to(study)).toBe('/app/isa-demo/qos-benchmarks/studies/engines-vs-seeds');
    expect(to('org=isa-demo&project=qos-benchmarks&run=run-1')).toBe('/app/jobs');
    expect(to('job=job-done-1&job=job-done-3')).toBe('/app/jobs');
    expect(to('report=isa-demo%2Fqos-benchmarks%2Fdecision-choice')).toBe('/app/jobs');
    expect(to('')).toBe('/app/jobs');
    expect(to('org=isa-demo&project=qos-benchmarks&study=&run=run-1')).toBe('/app/jobs');
    expect(to('org=isa-demo&project=qos-benchmarks&study=seeds%2F2026&study=other')).toBe('/app/isa-demo/qos-benchmarks/studies/seeds%2F2026');
  });

  // [utest->req~frontend-retire-redirect-generic~1]
  it('leads every target to a routed screen and is not itself a route', () => {
    const queries = ['', 'org=a&project=b&study=c', 'org=a&project=b&study=c&run=d'];
    for (const route of RETIRED_ROUTES) {
      for (const query of queries) {
        const target = route.target(new URLSearchParams(query));
        expect(matchRoutes(config, target), `${route.id} ${query} -> ${target}`).not.toBeNull();
      }
      expect(routeDefinitions.map((definition) => definition.path)).not.toContain(route.path);
    }
  });
});
