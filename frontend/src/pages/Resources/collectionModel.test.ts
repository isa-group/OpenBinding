import { describe, expect, it } from 'vitest';
import { caseOf, revisionOf } from '../Project/testKit';
import {
  buildPins, differences, entriesOf, entryFromPin, entryOf, move, newestFirst, sameList, typeSummary, type Entry,
} from './collectionModel';
import { caseItem, collectionOf, collectionRevisionOf, digestOf, resourceItem, resourceOf, resourceRevisionOf } from '../../test/fixtures/resources';

const root = '/app/isa-demo/qos-benchmarks';
const flujo = caseOf('flujo-checkout', 'Flujo de checkout');
const c1 = revisionOf(flujo, 1);
const c2 = revisionOf(flujo, 2);
const weights = resourceOf('weights', 'Weights');
const w1 = resourceRevisionOf(weights, 1);
const w2 = resourceRevisionOf(weights, 2);
const pins = buildPins([{ item: flujo, revisions: [c1, c2] }], [{ resource: weights, revisions: [w1, w2] }], root);

const entry = (key: string): Entry => ({ kind: 'case', key, label: key, sub: '', digest: key, pin: null });

describe('buildPins', () => {
  it('offers the newest revision of each case and resource first, cases before resources', () => {
    expect(pins.map((pin) => pin.label)).toEqual(['Flujo de checkout · revision 2', 'Flujo de checkout · revision 1', 'Weights · revision 2', 'Weights · revision 1']);
  });

  it('pins a case by its revision id and fingerprint', () => {
    expect(pins[0]).toMatchObject({
      kind: 'case', key: `case:${c2.digest}`, sub: 'Case revision', href: `${root}/cases/flujo-checkout/revisions/2`,
      item: { target_kind: 'case', target_digest: c2.digest, target_ref: { caseRevisionId: c2.id } },
    });
  });

  it('pins a resource by its revision id and content fingerprint, and remembers how the gateway will name it', () => {
    expect(pins[3]).toMatchObject({
      kind: 'resource', key: `resource:${w1.digest}`, slug: 'weights', ordinal: 1, href: `${root}/resources/weights`,
      item: { target_kind: 'resource', target_digest: w1.digest, target_ref: { resourceRevisionId: w1.id } },
    });
  });
});

describe('entryOf', () => {
  it('matches a stored case item with its revision', () => {
    const found = entryOf(caseItem(c1.id, c1.digest), pins);
    expect(found).toMatchObject({ kind: 'case', label: 'Flujo de checkout · revision 1', href: `${root}/cases/flujo-checkout/revisions/1` });
    expect(found.pin).toEqual({ target_kind: 'case', target_digest: c1.digest, target_ref: { caseRevisionId: c1.id } });
  });

  it('keeps a case item whose revision is no longer listed, and can still send it back', () => {
    const found = entryOf(caseItem('case-gone-r9', digestOf('9')), pins);
    expect(found.label).toBe('Case revision case-gon');
    expect(found.pin).toEqual({ target_kind: 'case', target_digest: digestOf('9'), target_ref: { caseRevisionId: 'case-gone-r9' } });
  });

  it('matches a stored resource item by address and revision number, since the gateway lists it by library reference', () => {
    const found = entryOf(resourceItem('weights', '2', digestOf('f')), pins);
    expect(found).toMatchObject({ kind: 'resource', label: 'Weights · revision 2', digest: w2.digest });
    expect(found.pin).toEqual({ target_kind: 'resource', target_digest: w2.digest, target_ref: { resourceRevisionId: w2.id } });
  });

  it('cannot turn a library reference that is not one of the project’s resources back into a pin', () => {
    const found = entryOf(resourceItem('library-catalog', '3', digestOf('c')), pins);
    expect(found).toMatchObject({ kind: 'resource', label: 'library-catalog · revision 3', sub: 'Pinned from the library', pin: null });
  });

  it('does not make up a revision number for a label that is not one', () => {
    expect(entryOf(resourceItem('library-catalog', 'stable', digestOf('c')), pins).label).toBe('library-catalog · stable');
  });

  it('flags an item of a kind the gateway cannot pin', () => {
    const found = entryOf({ target_kind: 'report', target_digest: digestOf('d'), target_ref: { reportId: 'x' } }, pins);
    expect(found).toMatchObject({ kind: 'report', sub: 'Not supported', pin: null });
  });

  it('reads a whole revision in order', () => {
    const revision = collectionRevisionOf(collectionOf('c'), 1, [caseItem(c2.id, c2.digest), caseItem(c1.id, c1.digest)]);
    expect(entriesOf(revision, pins).map((item) => item.label)).toEqual(['Flujo de checkout · revision 2', 'Flujo de checkout · revision 1']);
    expect(entriesOf(undefined, pins)).toEqual([]);
  });

  it('turns a pin into a line of the list', () => {
    expect(entryFromPin(pins[2])).toMatchObject({ kind: 'resource', key: pins[2].key, label: 'Weights · revision 2', pin: pins[2].item });
  });
});

describe('the list', () => {
  it('moves an entry one place and leaves the ends alone', () => {
    expect(move(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(move(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(move(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(move(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(move(['a'], 5, 1)).toEqual(['a']);
  });

  it('does not change the list it is given', () => {
    const list = ['a', 'b'];
    move(list, 0, 1);
    expect(list).toEqual(['a', 'b']);
  });

  it('tells equal lists from different ones by what is in them and in which order', () => {
    expect(sameList([entry('a'), entry('b')], [entry('a'), entry('b')])).toBe(true);
    expect(sameList([entry('a'), entry('b')], [entry('b'), entry('a')])).toBe(false);
    expect(sameList([entry('a')], [entry('a'), entry('b')])).toBe(false);
    expect(sameList([], [])).toBe(true);
  });

  it('puts the newest revision first', () => {
    const collection = collectionOf('c');
    const list = [collectionRevisionOf(collection, 1, []), collectionRevisionOf(collection, 3, []), collectionRevisionOf(collection, 2, [])];
    expect(newestFirst(list).map((revision) => revision.revision)).toEqual([3, 2, 1]);
  });
});

describe('differences', () => {
  it('names what came, what left and what changed place', () => {
    const before = [entry('a'), entry('b'), entry('c')];
    const after = [entry('c'), entry('a'), entry('d')];
    expect(differences(before, after)).toEqual([
      { kind: 'added', label: 'd' },
      { kind: 'removed', label: 'b' },
      { kind: 'moved', label: 'c', from: 3, to: 1 },
      { kind: 'moved', label: 'a', from: 1, to: 2 },
    ]);
  });

  it('finds nothing between the same list', () => {
    expect(differences([entry('a'), entry('b')], [entry('a'), entry('b')])).toEqual([]);
    expect(differences([], [])).toEqual([]);
  });

  it('reports a swap as two moves', () => {
    expect(differences([entry('a'), entry('b')], [entry('b'), entry('a')])).toEqual([
      { kind: 'moved', label: 'b', from: 2, to: 1 },
      { kind: 'moved', label: 'a', from: 1, to: 2 },
    ]);
  });

  it('does not call an item moved only because something before it left', () => {
    expect(differences([entry('a'), entry('b'), entry('c')], [entry('b'), entry('c')])).toEqual([{ kind: 'removed', label: 'a' }]);
  });
});

describe('typeSummary', () => {
  it('counts what a collection points to, by kind', () => {
    const items = [caseItem(c1.id, c1.digest), caseItem(c2.id, c2.digest), resourceItem('weights', '1', digestOf('a'))];
    expect(typeSummary(items)).toEqual(['2 case revisions', '1 resource version']);
    expect(typeSummary(items.slice(0, 1))).toEqual(['1 case revision']);
    expect(typeSummary([])).toEqual([]);
  });

  it('does not hide an item of another kind', () => {
    expect(typeSummary([{ target_kind: 'report', target_digest: digestOf('d'), target_ref: {} }])).toEqual(['1 other item']);
  });
});
