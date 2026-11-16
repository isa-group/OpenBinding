import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The gateway's views are never written by hand in the frontend: src/shared/api/openapi.ts is generated from the committed
// snapshot docs/openapi.json, and this fails when the two have drifted apart (a gateway change without `pnpm gen:api`).
const frontend = fileURLToPath(new URL('../../..', import.meta.url));

describe('the generated API types', () => {
  it('match docs/openapi.json', () => {
    const run = spawnSync(process.execPath, ['scripts/gen-api.mjs', '--check'], { cwd: frontend, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
