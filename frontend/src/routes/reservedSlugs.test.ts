import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// An organization's page is `/orgs/:org`, so every static child of `/orgs/` in the route table (`/orgs/new`,
// `/orgs/join/:code`) would shadow an organization with that slug. The gateway refuses those slugs at creation
// (`RESERVED_ORGANIZATION_SLUGS` in models/platform.py, with `public`, which would shadow its own
// `GET /v1/organizations/public`); this test reads both files as text and keeps them equal.

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

function staticOrgChildren(): string[] {
  const router = read('src/routes/router.tsx');
  return [
    ...new Set([...router.matchAll(/path: '\/orgs\/([^':/]+)/g)].map(match => match[1])),
  ].sort();
}

function gatewayReservedSlugs(): string[] {
  const source = read('../openbinding-gateway/src/openbinding_gateway/models/platform.py');
  const block = /RESERVED_ORGANIZATION_SLUGS = frozenset\(\{([^}]*)\}\)/.exec(source);
  expect(block, 'RESERVED_ORGANIZATION_SLUGS in models/platform.py').not.toBeNull();
  return [...block![1].matchAll(/"([a-z0-9-]+)"/g)].map(match => match[1]).sort();
}

describe('reserved organization slugs', () => {
  it('reads the static children of /orgs/ in the route table', () => {
    expect(staticOrgChildren()).toEqual(['join', 'new']);
  });

  it('are, in the gateway, exactly those children and `public`', () => {
    expect(gatewayReservedSlugs()).toEqual([...staticOrgChildren(), 'public'].sort());
  });
});
