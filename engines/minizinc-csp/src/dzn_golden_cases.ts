/**
 * The instances the DZN snapshots are taken from.
 *
 * Three shapes, chosen to reach every branch of the emission: a plain problem,
 * one exercising the composition operators the model encodes specially, and
 * one carrying both placement blocks.
 *
 * They are checked-in copies of the bundled examples in their canonical form,
 * not the examples themselves. An example may be written with the authoring
 * shorthands - a bare task id for a leaf, a candidate saying where it runs -
 * and expanding those is the gateway's job, done once on the way in. This
 * engine only ever sees the expansion, so that is what it is tested against.
 * Regenerate them with:
 *
 *     python openbinding-gateway/tools/bim_desugar.py \
 *         examples/placement/01_small_placement.json \
 *         -o engines/minizinc-csp/tests/fixtures/placement.json
 */

import fs from 'node:fs';
import path from 'node:path';

export const GOLDEN_DIR = path.join(__dirname, '..', 'tests', 'golden');

const FIXTURE_DIR = path.join(__dirname, '..', 'tests', 'fixtures');

function canonical(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

export const GOLDEN_CASES: Record<string, () => any> = {
  // Plain: no placement blocks, so every placement array must come out empty.
  'simple-sequence': () => canonical('simple-sequence'),

  // LOOP and XOR: the two composition operators with their own encodings.
  'loops': () => canonical('loops'),
  'xor-choice': () => canonical('xor-choice'),

  // Placement: pools, capacities, transitions, scenarios, the e2e latency, and
  // one candidate serving every task, which is what makes sharing visible.
  'placement': () => canonical('placement'),
};
