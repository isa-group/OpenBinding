/**
 * The instances the DZN snapshots are taken from.
 *
 * Three shapes, chosen to reach every branch of the emission: a plain problem,
 * one exercising the composition operators the model encodes specially, and
 * one carrying both placement blocks.
 */

import fs from 'node:fs';
import path from 'node:path';

export const GOLDEN_DIR = path.join(__dirname, '..', 'tests', 'golden');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function example(...parts: string[]): any {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'examples', ...parts), 'utf8'));
}

export const GOLDEN_CASES: Record<string, () => any> = {
  // Plain: no placement blocks, so every placement array must come out empty.
  'simple-sequence': () => example('demo', '01_simple_seq.json'),

  // LOOP and XOR: the two composition operators with their own encodings.
  'loops': () => example('demo', '06_loops.json'),
  'xor-choice': () => example('demo', '03_xor_choice.json'),

  // Placement: pools, capacities, transitions, scenarios and the e2e latency.
  'placement': () => example('placement', '01_small_placement.json'),
};
