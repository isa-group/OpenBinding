import { describe, expect, it } from 'vitest';
import { organizationOfPath } from './organizationOfPath';

describe('organizationOfPath', () => {
  it.each([
    ['/orgs/isa-demo', '', 'isa-demo'],
    ['/orgs/isa-demo/runs', '', 'isa-demo'],
    ['/compositions/isa-demo/fleet-plan/versions', '', 'isa-demo'],
    ['/problems/isa-demo/checkout', '', 'isa-demo'],
    ['/runs/isa-demo/job-1', '', 'isa-demo'],
    ['/studies/isa-demo/s1/front', '', 'isa-demo'],
    ['/runs/new', '?org=qos-lab&problem=p', 'qos-lab'],
    ['/studies/new', '', undefined],
    ['/orgs/new', '', undefined],
    ['/orgs/join/abc', '', undefined],
    ['/compositions', '', undefined],
    ['/engines/bim/edge/1.0.0', '', undefined],
    ['/', '', undefined],
  ])('%s%s names %s', (pathname, search, org) => {
    expect(organizationOfPath(pathname, search)).toBe(org);
  });
});
