import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectionVersionLabel,
  engineLabel,
  problemVersionLabel,
  publishedResultLabel,
  runLabel,
  studyRunLabel,
} from './identity';

const SEALED = '2026-08-20T09:30:00Z';
const PV = { name: 'checkout-flow', version: 3, sealedAt: SEALED };
const ENGINE = { name: 'minizinc-csp', version: '1.1.1', mode: 'exact' };
const RUN = { number: 14, problem: { name: 'checkout-flow', version: 3 }, engine: ENGINE, createdAt: '2026-10-21T16:05:00Z' };
const STUDY_RUN = { study: 'engines-vs-suite', number: 3, createdAt: '2026-10-21T08:00:00Z' };
const PUBLISHED = { title: 'Engines versus the ICWS suite', publishedAt: '2026-10-22T12:00:00Z' };
const COLLECTION = { name: 'QACOBench icws', version: 2, problemCount: 12 };

const FULL_DIGEST = `sha256-${'a'.repeat(64)}`;
const SHORT_DIGEST = 'sha256-e5f6…0718';
const HEX_40 = 'e'.repeat(40);
const HEX_64 = '0'.repeat(64);
const UUID_VALUE = '3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f';

const SHAPES = [/sha256-/i, /[0-9a-f]{40}/i, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i];

describe('identity labels', () => {
  // [utest->req~identity-labels~1]
  it('problem version', () => {
    expect(problemVersionLabel(PV)).toBe('checkout-flow v3 · sealed 20 Aug 2026');
  });

  // [utest->req~identity-labels~1]
  it('collection version, singular and plural', () => {
    expect(collectionVersionLabel(COLLECTION)).toBe('QACOBench icws v2 · 12 problems');
    expect(collectionVersionLabel({ ...COLLECTION, problemCount: 1 })).toBe('QACOBench icws v2 · 1 problem');
    expect(collectionVersionLabel({ ...COLLECTION, problemCount: 0 })).toBe('QACOBench icws v2 · 0 problems');
    expect(collectionVersionLabel({ ...COLLECTION, problemCount: 1200 })).toBe('QACOBench icws v2 · 1,200 problems');
  });

  // [utest->req~identity-labels~1]
  it('run, study run, published result and engine', () => {
    expect(runLabel(RUN)).toBe('run 14 of checkout-flow v3 · minizinc-csp 1.1.1 exact · 21 Oct 2026');
    expect(studyRunLabel(STUDY_RUN)).toBe('engines-vs-suite run 3 · 21 Oct 2026');
    expect(publishedResultLabel(PUBLISHED)).toBe('Engines versus the ICWS suite · published 22 Oct 2026');
    expect(engineLabel(ENGINE)).toBe('minizinc-csp 1.1.1 · mode exact');
  });

  // [utest->req~identity-labels~1]
  it('dates are UTC with fixed month names and no leading zero', () => {
    const at = (sealedAt: string) => problemVersionLabel({ name: 'checkout-flow', version: 3, sealedAt });
    expect(at('2026-09-01T23:30:00-02:00')).toBe('checkout-flow v3 · sealed 2 Sep 2026');
    expect(at('2026-12-05T00:00:00Z')).toBe('checkout-flow v3 · sealed 5 Dec 2026');
    expect(at('soon')).toBe('checkout-flow v3');
    expect(at('2026-01-31T23:59:59Z')).toBe('checkout-flow v3 · sealed 31 Jan 2026');
    expect(at('2026-09-30T23:30:00-02:00')).toBe('checkout-flow v3 · sealed 1 Oct 2026');
  });

  // [utest->req~identity-labels~1]
  it('drops missing parts of a problem version', () => {
    expect(problemVersionLabel({ ...PV, sealedAt: undefined })).toBe('checkout-flow v3');
    expect(problemVersionLabel({ ...PV, version: null })).toBe('checkout-flow · sealed 20 Aug 2026');
    expect(problemVersionLabel({ ...PV, name: '  ' })).toBe('problem v3 · sealed 20 Aug 2026');
    expect(problemVersionLabel({ ...PV, version: 0 })).toBe('checkout-flow · sealed 20 Aug 2026');
    expect(problemVersionLabel({})).toBe('problem version');
    expect(problemVersionLabel({ sealedAt: SEALED })).toBe('problem version · sealed 20 Aug 2026');
  });

  // [utest->req~identity-labels~1]
  it('drops missing parts of the other labels', () => {
    expect(collectionVersionLabel({ ...COLLECTION, problemCount: undefined })).toBe('QACOBench icws v2');
    expect(collectionVersionLabel({})).toBe('collection version');
    expect(runLabel({ ...RUN, number: undefined })).toBe('run of checkout-flow v3 · minizinc-csp 1.1.1 exact · 21 Oct 2026');
    expect(runLabel({ ...RUN, problem: undefined, engine: { ...ENGINE, mode: undefined } })).toBe('run 14 · minizinc-csp 1.1.1 · 21 Oct 2026');
    expect(runLabel({})).toBe('run');
    expect(studyRunLabel({ ...STUDY_RUN, study: undefined })).toBe('study run 3 · 21 Oct 2026');
    expect(studyRunLabel({ ...STUDY_RUN, number: undefined })).toBe('engines-vs-suite run · 21 Oct 2026');
    expect(studyRunLabel({})).toBe('study run');
    expect(publishedResultLabel({ ...PUBLISHED, publishedAt: undefined })).toBe('Engines versus the ICWS suite');
    expect(publishedResultLabel({ ...PUBLISHED, title: undefined })).toBe('published result · published 22 Oct 2026');
    expect(publishedResultLabel({})).toBe('published result');
    expect(engineLabel({ ...ENGINE, mode: undefined })).toBe('minizinc-csp 1.1.1');
    expect(engineLabel({ ...ENGINE, name: undefined })).toBe('engine 1.1.1 · mode exact');
    expect(engineLabel({})).toBe('engine');
  });

  // [utest->req~identity-labels~1]
  it('treats an identifier-shaped value as missing, as a whole', () => {
    expect(problemVersionLabel({ ...PV, name: UUID_VALUE })).toBe('problem v3 · sealed 20 Aug 2026');
    expect(engineLabel({ ...ENGINE, version: FULL_DIGEST })).toBe('minizinc-csp · mode exact');
    expect(publishedResultLabel({ ...PUBLISHED, title: `Edition ${'e5f6'.repeat(10)}` })).toBe('published result · published 22 Oct 2026');
    expect(studyRunLabel({ ...STUDY_RUN, study: SHORT_DIGEST })).toBe('study run 3 · 21 Oct 2026');
  });

  // [utest->req~identity-labels~1]
  it('catches a digest prefix in any case, a long hex run glued to letters and a UUID in upper case', () => {
    expect(engineLabel({ name: 'SHA256-ABCDEF0123456789', version: '1' })).toBe('engine 1');
    expect(engineLabel({ name: `build${HEX_64}`, version: '1' })).toBe('engine 1');
    expect(engineLabel({ name: `x_${HEX_40}`, version: '1' })).toBe('engine 1');
    expect(engineLabel({ name: UUID_VALUE.toUpperCase(), version: '1' })).toBe('engine 1');
    expect(engineLabel({ name: 'e'.repeat(39), version: '1' })).toBe(`${'e'.repeat(39)} 1`);
  });

  // [utest->req~identity-labels~1]
  it('prefixes a version with v once and shows engine versions as given', () => {
    expect(problemVersionLabel({ name: 'p', version: 'v3' })).toBe('p v3');
    expect(problemVersionLabel({ name: 'p', version: '3' })).toBe('p v3');
    expect(problemVersionLabel({ name: 'p', version: 2.5 })).toBe('p');
    expect(engineLabel({ name: 'e', version: '1.0.0+builtin.a' })).toBe('e 1.0.0+builtin.a');
    expect(runLabel({ number: 1014 })).toBe('run 1014');
  });

  // [utest->req~identity-labels~1]
  it('never carries an identifier and is never empty, for a table of values', () => {
    const texts: Array<string | undefined> = ['valid', undefined, FULL_DIGEST, SHORT_DIGEST, HEX_40, HEX_64, UUID_VALUE];
    const numbers: Array<number | undefined> = [3, undefined, 0, -1];
    const dates: Array<string | undefined> = ['2026-08-20T09:30:00Z', undefined, 'soon'];
    let calls = 0;
    const bad: string[] = [];
    const check = (result: string) => {
      calls += 1;
      if (result === '' || SHAPES.some((shape) => shape.test(result))) bad.push(result);
    };
    for (const a of texts) for (const n of numbers) for (const d of dates) {
      check(problemVersionLabel({ name: a, version: n, sealedAt: d }));
      for (const c of numbers) check(collectionVersionLabel({ name: a, version: n, problemCount: c }));
      check(studyRunLabel({ study: a, number: n, createdAt: d }));
      check(publishedResultLabel({ title: a, publishedAt: d }));
      for (const v of texts) for (const m of texts) check(engineLabel({ name: a, version: v, mode: m }));
    }
    for (const pn of texts) for (const ev of texts) for (const en of texts) for (const em of texts) {
      for (const number of numbers) for (const pv of numbers) for (const d of dates) {
        check(runLabel({ number, problem: { name: pn, version: pv }, engine: { name: en, version: ev, mode: em }, createdAt: d }));
      }
    }
    expect(calls).toBeGreaterThan(115_000);
    expect(bad).toEqual([]);
  });

  // [utest->req~identity-labels~1]
  it('reads a date-time without an offset as UTC', () => {
    expect(problemVersionLabel({ name: 'p', version: 1, sealedAt: '2026-08-20T23:30:00' })).toBe('p v1 · sealed 20 Aug 2026');
    expect(problemVersionLabel({ name: 'p', version: 1, sealedAt: '2026-08-20' })).toBe('p v1 · sealed 20 Aug 2026');
  });
});

describe.each(['Pacific/Kiritimati', 'America/Los_Angeles'])('dates in the %s time zone', (zone) => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = zone;
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const at = (sealedAt: string) => problemVersionLabel({ name: 'p', version: 1, sealedAt });

  // [utest->req~identity-labels~1]
  it('really runs in the requested zone', () => {
    const offset = new Date('2026-08-20T12:00:00Z').getTimezoneOffset();
    expect(offset).toBe(zone === 'Pacific/Kiritimati' ? -840 : 420);
  });

  // [utest->req~identity-labels~1]
  it('reads offset-bearing, Z, offset-less and date-only values as UTC', () => {
    expect(at('2026-08-20T09:30:00Z')).toBe('p v1 · sealed 20 Aug 2026');
    expect(at('2026-08-20T23:30:00')).toBe('p v1 · sealed 20 Aug 2026');
    expect(at('2026-08-20T23:30')).toBe('p v1 · sealed 20 Aug 2026');
    expect(at('2026-08-20T23:30:00.123')).toBe('p v1 · sealed 20 Aug 2026');
    expect(at('2026-08-20T00:00:00')).toBe('p v1 · sealed 20 Aug 2026');
    expect(at('2026-08-20')).toBe('p v1 · sealed 20 Aug 2026');
    expect(at('2026-12-31T23:59:59Z')).toBe('p v1 · sealed 31 Dec 2026');
    expect(at('2026-09-01T23:30:00-02:00')).toBe('p v1 · sealed 2 Sep 2026');
    expect(at('2026-09-30T23:30:00-02:00')).toBe('p v1 · sealed 1 Oct 2026');
    expect(at('2026-08-20T01:00:00+05:00')).toBe('p v1 · sealed 19 Aug 2026');
  });

  // [utest->req~identity-labels~1]
  it('reads a date-time with a space and no offset as UTC', () => {
    expect(at('2026-08-20 23:30:00')).toBe('p v1 · sealed 20 Aug 2026');
    expect(at('2026-08-20 23:30')).toBe('p v1 · sealed 20 Aug 2026');
    expect(at('2026-08-20 00:00:00.5')).toBe('p v1 · sealed 20 Aug 2026');
    expect(at('2026-08-20 23:30:00Z')).toBe('p v1 · sealed 20 Aug 2026');
    expect(at('2026-08-20 23:30:00-02:00')).toBe('p v1 · sealed 21 Aug 2026');
  });
});
