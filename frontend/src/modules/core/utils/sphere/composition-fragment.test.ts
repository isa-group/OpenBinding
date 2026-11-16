// Adapted from SPHERE frontend/test/pricing-fragment.test.ts (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: node:test becomes vitest, `t.diagnostic` is dropped, the petclinic pricing template becomes a declared
// Composition2Yaml document, and the large sample is a composition (no client parser checks it: the gateway reads
// Composition2Yaml, and the round trip here is about the bytes).

import LZString from 'lz-string';
import { describe, expect, it } from 'vitest';

import declared from '../../../../test/fixtures/compositions/declared.yaml?raw';
import {
  compositionFragment,
  readCompositionFragment,
  takeCompositionFragment,
  urlWithoutFragment,
} from './composition-fragment';

const encode = (yaml: string) => LZString.compressToEncodedURIComponent(yaml);

/** A Composition2Yaml document of about `targetBytes`: a long sequence of bound tasks with values of their own. */
function largeComposition(targetBytes: number): string {
  // Candidate names made of varied words, so that the sample compresses about as
  // well as real documents do, not like a repeated template.
  const words = [
    'access',
    'reports',
    'team',
    'workspace',
    'custom',
    'priority',
    'export',
    'audit',
    'storage',
    'guests',
    'automation',
    'integrations',
    'dashboards',
    'permissions',
    'history',
    'templates',
    'sync',
    'api',
    'support',
    'roles',
  ];
  let seed = 7;
  const nextWord = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return words[(seed >>> 16) % words.length];
  };

  const steps: string[] = [];
  const binding: string[] = [];
  const values: string[] = [];
  for (
    let i = 0;
    steps.join('').length + binding.join('').length + values.join('').length < targetBytes - 500;
    i++
  ) {
    steps.push(`    - task${i}\n`);
    binding.push(
      `  task${i}: {candidate: ${nextWord()}.${nextWord()}.${nextWord()}${seed % 9973}}\n`
    );
    values.push(`  ${nextWord()}_${i}: {value: ${seed % 9973}.5, unit: ${nextWord()}/month}\n`);
  }

  return (
    'syntaxVersion: "1.0"\n' +
    'composition: generated\n' +
    'version: 1.0.0\n' +
    'kind: application\n' +
    `workflow:\n  seq:\n${steps.join('')}` +
    `binding:\n${binding.join('')}` +
    `values:\n${values.join('')}`
  );
}

describe('the composition fragment', () => {
  it('leaves a URL without a composition fragment to the page', () => {
    for (const hash of ['', '#', '#section', '#foo=bar', 'foo=bar&baz']) {
      expect(readCompositionFragment(hash), hash).toEqual({ status: 'absent' });
    }
  });

  it('decodes #composition= to the YAML that was encoded', () => {
    const encoded = encode(declared);

    expect(readCompositionFragment(`#composition=${encoded}`)).toEqual({
      status: 'ok',
      yaml: declared,
    });
    // `location.hash` includes the `#`, but the leading `#` is optional.
    expect(readCompositionFragment(`composition=${encoded}`)).toEqual({
      status: 'ok',
      yaml: declared,
    });
  });

  it('writes the fragment it reads', () => {
    const fragment = compositionFragment(declared);

    expect(fragment).toBe(`#composition=${encode(declared)}`);
    expect(readCompositionFragment(fragment)).toEqual({ status: 'ok', yaml: declared });
  });

  it('reads only the composition key of the fragment', () => {
    const encoded = encode(declared);

    expect(readCompositionFragment(`#foo=bar&composition=${encoded}&baz=1`)).toEqual({
      status: 'ok',
      yaml: declared,
    });
  });

  it('decodes the value whether or not it was percent-encoded again', () => {
    const yaml = `${declared}# ${'+$-'.repeat(20)} ünïcödé €\n`;
    const encoded = encode(yaml);

    // The sample must exercise the characters that form decoding alters.
    expect(encoded).toMatch(/[+$-]/);
    expect(readCompositionFragment(`#composition=${encoded}`)).toEqual({ status: 'ok', yaml });
    expect(readCompositionFragment(`#composition=${encodeURIComponent(encoded)}`)).toEqual({
      status: 'ok',
      yaml,
    });
  });

  it('answers an empty composition fragment with an error', () => {
    for (const hash of [
      '#composition',
      '#composition=',
      '#composition=%20%20',
      `#composition=${encode('  \n ')}`,
    ]) {
      const result = readCompositionFragment(hash);

      expect(result.status, hash).toBe('invalid');
      expect((result as { error: string }).error, hash).toMatch(
        /could not be read: it carries no composition/
      );
    }
  });

  it('answers a value that is not lz-string output with an error', () => {
    for (const hash of [
      '#composition=<script>alert(1)</script>',
      '#composition=syntaxVersion%3A%20X',
      '#composition=a.b',
    ]) {
      const result = readCompositionFragment(hash);

      expect(result.status, hash).toBe('invalid');
      expect((result as { error: string }).error, hash).toMatch(
        /not lz-string compressToEncodedURIComponent output/
      );
    }
  });

  it('answers a damaged or cut value with an error', () => {
    const encoded = encode(declared);

    // `----` makes lz-string return null, `zzzz` makes it throw, `AAAA` decodes to ''.
    for (const value of ['----', 'zzzz', 'AAAA', encoded.slice(0, 5)]) {
      const result = readCompositionFragment(`#composition=${value}`);

      expect(result.status, value).toBe('invalid');
      expect((result as { error: string }).error, value).toMatch(/damaged or incomplete/);
    }
  });

  it('removes the fragment from the URL when taking it, and keeps the query and the history state', () => {
    const encoded = encode(declared);
    const state = { usr: null, key: 'abc', idx: 3 };
    const calls: unknown[][] = [];
    const history = {
      state,
      replaceState: (...args: unknown[]) => {
        calls.push(args);
      },
    };

    const result = takeCompositionFragment(
      { hash: `#composition=${encoded}`, pathname: '/language', search: '?view=canonical' },
      history
    );

    expect(result).toEqual({ status: 'ok', yaml: declared });
    expect(calls).toHaveLength(1);
    // The router keeps its own state in the entry.
    expect(calls[0][0]).toBe(state);
    expect(calls[0][1]).toBe('');
    expect(calls[0][2]).toBe('/language?view=canonical');
  });

  it('removes an unreadable fragment as well', () => {
    const calls: unknown[][] = [];
    const result = takeCompositionFragment(
      { hash: '#composition=----', pathname: '/language', search: '' },
      { state: null, replaceState: (...args: unknown[]) => void calls.push(args) }
    );

    expect(result.status).toBe('invalid');
    expect(calls).toEqual([[null, '', '/language']]);
  });

  it('does not rewrite a URL without a composition fragment', () => {
    const calls: unknown[][] = [];

    for (const hash of ['', '#section']) {
      takeCompositionFragment(
        { hash, pathname: '/language', search: '?composition=abc' },
        { state: null, replaceState: (...args: unknown[]) => void calls.push(args) }
      );
    }

    expect(calls).toEqual([]);
  });

  it('keeps the path and the query in the URL without its fragment', () => {
    expect(urlWithoutFragment({ pathname: '/language', search: '' })).toBe('/language');
    expect(urlWithoutFragment({ pathname: '/language', search: '?a=1&b=2' })).toBe(
      '/language?a=1&b=2'
    );
  });

  it('decodes a large composition (~53 KB) whole and quickly', () => {
    const yaml = largeComposition(53 * 1024);
    const rawBytes = new TextEncoder().encode(yaml).length;

    expect(rawBytes).toBeGreaterThan(50 * 1024);
    expect(rawBytes).toBeLessThan(56 * 1024);

    const encoded = encode(yaml);
    const started = performance.now();
    const result = readCompositionFragment(`#composition=${encoded}`);
    const elapsed = performance.now() - started;

    expect(result).toEqual({ status: 'ok', yaml });
    // Generous bound so a slow CI runner does not fail it; it takes a few ms.
    expect(elapsed).toBeLessThan(1_000);
  });
});
