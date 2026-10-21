import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** jsdom cannot measure pixels; this checks that the phone rule of globals.css names the selectors the visual QA reported. */
const read = (path: string) => readFileSync(`${process.cwd()}/src/${path}`, 'utf8');
const css = read('styles/globals.css');

function mobileBlock(): string {
  const start = css.indexOf('@media (max-width: 640px) {\n  button, summary');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unbalanced media block');
}

describe('mobile touch targets (max-width: 640px)', () => {
  const block = mobileBlock();

  it('gives interactive controls a 24px minimum height', () => {
    for (const selector of ['button', 'summary', "[role='button']", "[role='tab']"]) expect(block).toContain(selector);
    expect(block).toMatch(/min-height: 24px/);
  });

  it('covers every link outside running text, with zero specificity', () => {
    expect(block).toMatch(/:where\(a\[href\]:not\(:is\(p, h1, h2, h3, h4, h5, h6, dd, small, label, \.prose/);
    expect(block).toMatch(/display: inline-flex;\s*min-height: 24px;\s*align-items: center;/);
  });

  it('names the containers where the real run found short links', () => {
    for (const selector of ['.ui-action', '.ui-action.is-link', '.case-rev-links a', '.usage-consoles a', '.proj-job a', '.job-wizard a', '.job-fact a']) {
      expect(block).toContain(selector);
    }
  });

  it('beats the min-height: 0 of the link action with a specific selector, on phones only', () => {
    const rule = /:is\(a, button\)\.ui-action\.is-link \{\s*min-height: 24px;\s*align-items: center;\s*vertical-align: middle;\s*\}/;
    expect(block).toMatch(rule);
    expect(read('components/ui/Action.css')).toMatch(/\.ui-action\.is-link \{ min-height: 0;/);
    expect(css.slice(0, css.indexOf(block))).not.toMatch(rule);
  });

  it('keeps the job-result links in a container that exists in the markup', () => {
    const facts = read('pages/Jobs/JobFacts.tsx');
    expect(facts).toContain('className="job-fact"');
  });

  it('does not touch the desktop layout', () => {
    expect(css.slice(0, css.indexOf(block))).not.toContain('.job-fact a');
  });
});
