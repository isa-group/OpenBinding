/**
 * Characterization test: the generated DZN must not move.
 *
 * The builder is being split into encoders, one per element of the tuple. Any
 * change to what it emits shows up here as a text diff, which is the point:
 * the model can only enforce what the data file says.
 *
 * Regenerate with `pnpm run regenerate-dzn-golden`, and only when a change to
 * the emission is intended and reviewed.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DznBuilder } from './dzn_builder';
import { GOLDEN_CASES, GOLDEN_DIR } from './dzn_golden_cases';

describe('generated DZN', () => {
  for (const [name] of Object.entries(GOLDEN_CASES)) {
    it(`is unchanged for ${name}`, () => {
      const goldenPath = path.join(GOLDEN_DIR, `${name}.dzn`);
      assert.ok(
        fs.existsSync(goldenPath),
        `no snapshot for ${name}; run pnpm run regenerate-dzn-golden`
      );

      const actual = new DznBuilder().build(GOLDEN_CASES[name](), {}).dznContent;
      const expected = fs.readFileSync(goldenPath, 'utf8');

      assert.equal(actual, expected);
    });
  }
});
