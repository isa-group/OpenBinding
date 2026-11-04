import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FRONTEND = process.cwd();
const DIST = join(FRONTEND, 'dist');
const HEADING = 'States and recoverable errors';

/** Every file under `dir` whose content holds `text`. */
const filesWith = (dir: string, text: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesWith(path, text);
    return readFileSync(path).includes(text) ? [path] : [];
  });

describe('production bundle', () => {
  it('finds a heading injected into a copy of the output, so the search below is not vacuous', () => {
    const root = mkdtempSync(join(tmpdir(), 'dist-copy-'));
    try {
      writeFileSync(join(root, 'clean.js'), 'console.log("clean")');
      expect(filesWith(root, HEADING)).toEqual([]);
      writeFileSync(join(root, 'injected.js'), `console.log("${HEADING}")`);
      expect(filesWith(root, HEADING)).toEqual([join(root, 'injected.js')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // [utest->req~frontend-nav-system-states-dev-only~1]
  it('holds the text of the states screen in no file of the output of pnpm build', () => {
    // The runner sets NODE_ENV=test, which would make the build a development one.
    const env = { ...process.env, NODE_ENV: 'production' };
    execFileSync('pnpm', ['build'], { cwd: FRONTEND, env, stdio: 'pipe', timeout: 280_000 });
    expect(existsSync(DIST)).toBe(true);
    expect(filesWith(DIST, HEADING)).toEqual([]);
  }, 300_000);
});
