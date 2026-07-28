/**
 * Write the DZN snapshots the golden test compares against.
 *
 *     pnpm run regenerate-dzn-golden
 *
 * Only when a change to the emission is intended and reviewed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { DznBuilder } from './dzn_builder';
import { GOLDEN_CASES, GOLDEN_DIR } from './dzn_golden_cases';

fs.mkdirSync(GOLDEN_DIR, { recursive: true });
for (const [name, load] of Object.entries(GOLDEN_CASES)) {
  const content = new DznBuilder().build(load(), {}).dznContent;
  fs.writeFileSync(path.join(GOLDEN_DIR, `${name}.dzn`), content);
  console.log(`wrote ${name}.dzn (${content.split('\n').length} lines)`);
}
