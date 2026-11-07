import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The suite is three projects because its files have three different costs, and a single default
// hid the difference: a whole-corpus scan and a React screen were given the same 15 s budget and
// the same share of the machine.

// Checks that read every source file as text, or run eslint over one. None of them touches the DOM,
// so they run in `node` and without the Testing Library setup, instead of paying for a jsdom they
// never use.
const CORPUS = [
  'src/api/removedOperations.test.ts',
  'src/hygiene.test.ts',
  'src/routes/links.test.ts',
  'src/routes/screenBudget.test.ts',
  'src/test/boundariesLint.test.ts',
  'src/test/digestHygiene.test.ts',
  'src/test/e2eSpecs.test.ts',
  'src/test/mobileTouchTargets.test.ts',
  'src/test/vocabulary.all.test.ts',
  'src/test/vocabulary.urls.test.ts',
];

// Spawns a real `pnpm build`, which takes minutes and wants every core it can reach.
const BUNDLE = ['src/routes/production-bundle.test.ts'];

// Half of the logical CPUs, which is the physical core count on a hyperthreaded machine: the work
// is CPU-bound, so a hyperthread sibling buys little and costs a whole jsdom. Vitest's own default
// is `availableParallelism() - 1`, which on a 16-thread laptop starts 15 forks against 8 real
// cores; the timeouts below are wall clock, so the suite then failed by load rather than by defect.
// On a 4-vCPU CI runner this yields 2, close to the 3 that CI already ran green.
const WORKERS = Math.max(2, Math.floor(availableParallelism() / 2));

// A renamed file would drop out of the list above and be picked up by `app` instead, where it would
// run in a jsdom it does not need, on a budget meant for a screen. The lists are small and the cost
// of being wrong is a slow return of the flakiness this config removes, so they are checked here.
for (const path of [...CORPUS, ...BUNDLE]) {
  if (!existsSync(new URL(path, import.meta.url))) {
    throw new Error(`vitest.config.ts names a test file that does not exist: ${path}`);
  }
}

export default defineConfig({
  test: {
    maxWorkers: WORKERS,
    coverage: { reporter: ['text', 'json-summary'] },
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'app',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          // Anything not named below stays here, so a new test file is picked up without a change.
          exclude: [...CORPUS, ...BUNDLE],
          maxWorkers: WORKERS,
          // 15 s was not a generous backstop, it was below the cost of real work: the slowest
          // legitimate test here (`refuses a matrix over 10,000 cells`, 25 synchronous renders of a
          // 10,400-cell projection) measures 16.8 s, and the slowest legitimate *passing* test 12.8 s,
          // so the old budget left a 1.17x margin and any load at all crossed it. What catches the
          // defect shape is `asyncUtilTimeout` in the setup file: an element that never appears is
          // reported there, in 5 s, as the element error it is. This is only the backstop against a
          // wedged test, so it is set well clear of real work --- 3.5x the slowest --- rather than
          // just above it.
          testTimeout: 60000,
          hookTimeout: 60000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'corpus',
          environment: 'node',
          include: CORPUS,
          maxWorkers: WORKERS,
          // Every file here is a pure read-only scan: no mock, no global or env mutation, not even
          // a lifecycle hook. Sharing one context across them cannot make the result order-dependent,
          // and it stops each fork re-transforming the same 365 sources.
          isolate: false,
          // The slowest of these spent 70 s on one eslint call under the heaviest contention measured;
          // 120 s is twice that. A whole-corpus scan has no timing contract to assert, so the budget
          // is set to be unreachable by load while still catching a hang.
          testTimeout: 120000,
          hookTimeout: 120000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'bundle',
          environment: 'node',
          include: BUNDLE,
          // The build is itself parallel, so it gets the machine to itself.
          maxWorkers: 1,
          testTimeout: 600000,
          hookTimeout: 600000,
        },
      },
    ],
  },
});
