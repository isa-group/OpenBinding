import { describe, expect, it } from 'vitest';
import type { VerifierEntity } from '../../api/platform';
import { ENTITY_KINDS, entityHref, entityKind } from './verifierOptions';

// The report page and the verifier are tested with their screens in pages/Reports; what stays here is the vocabulary of the verifier's matches.
const entity = (over: Partial<VerifierEntity>): VerifierEntity => ({ entity_type: 'case', id: 'id-1', ...over });

describe('what the verifier can match', () => {
  it('names every kind of element the gateway searches', () => {
    expect(ENTITY_KINDS.map((kind) => kind.type)).toEqual(['case', 'snapshot', 'collection', 'report', 'artifact', 'engine', 'study_run']);
    expect(entityKind('case')).toMatchObject({ label: 'Case revision', resolve: 'case-revision' });
    expect(entityKind('study_run').resolve).toBeUndefined();
  });

  it('reads an element the page does not know without failing', () => {
    expect(entityKind('hologram')).toEqual({ type: 'hologram', label: 'hologram' });
    expect(entityKind('study_run_cell').label).toBe('study run cell');
  });

  it('links a match to the screen that shows it, from routes this application serves', () => {
    const where = { organization_slug: 'isa-demo', project_slug: 'qos-benchmarks' };
    expect(entityHref(entity({ ...where, slug: 'checkout-flow' }))).toBe('/app/isa-demo/qos-benchmarks/cases/checkout-flow');
    expect(entityHref(entity({ ...where, entity_type: 'collection', slug: 'core' }))).toBe('/app/isa-demo/qos-benchmarks/collections/core');
    expect(entityHref(entity({ ...where, entity_type: 'study_run', slug: 'engines-vs-seeds', id: 'run-1' }))).toBe('/app/isa-demo/qos-benchmarks/studies/engines-vs-seeds/runs/run-1');
    expect(entityHref(entity({ ...where, entity_type: 'artifact' }))).toBe('/app/isa-demo/qos-benchmarks/files');
  });

  // [utest->req~frontend-retire-reports-entry-points-removed~1]
  it('links a report edition to the publications of its project, the retired report page being gone', () => {
    const where = { organization_slug: 'isa-demo', project_slug: 'qos-benchmarks' };
    expect(entityHref(entity({ ...where, entity_type: 'report', slug: 'engines report' }))).toBe('/app/isa-demo/qos-benchmarks/publications');
    expect(entityHref(entity({ ...where, entity_type: 'report', slug: 'engines-vs-seeds-informe' }))).toBe('/app/isa-demo/qos-benchmarks/publications');
    expect(entityHref(entity({ ...where, entity_type: 'report' }))).toBe('/app/isa-demo/qos-benchmarks/publications');
  });

  it('gives no link to a match that lives nowhere the person can open', () => {
    expect(entityHref(entity({ slug: 'checkout-flow' }))).toBeNull();
    expect(entityHref(entity({ entity_type: 'engine', slug: 'random-search' }))).toBeNull();
    expect(entityHref(entity({ organization_slug: 'isa-demo', project_slug: 'qos-benchmarks' }))).toBeNull();
  });
});
