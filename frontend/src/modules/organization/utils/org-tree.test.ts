import { describe, expect, it } from 'vitest';
import {
  TILE_COLOURS,
  ancestorsOf,
  atLeast,
  buildForest,
  canGrantOwner,
  descendantsOf,
  flatten,
  initialsOf,
  pathOf,
  roleSource,
  tileColour,
} from './org-tree';
import { slugFromName } from '../../core/utils/slug';
import { org } from '../../../features/workspace/testKit';

const group = org('isa-demo', { name: 'ISA Demo Group' });
const lab = org('qos-lab', {
  name: 'QoS Lab (sub-organización)',
  parent_id: group.id,
  effective_role: 'OWNER',
});
const side = org('side', { name: 'Side', parent_id: lab.id, effective_role: 'ADMIN' });
const all = [lab, side, group];

describe('roles', () => {
  it('compares roles by strength and treats a missing role as nothing', () => {
    expect(atLeast('ADMIN', 'ADMIN')).toBe(true);
    expect(atLeast('MEMBER', 'ADMIN')).toBe(false);
    expect(atLeast('OWNER', 'MEMBER')).toBe(true);
    expect(atLeast(null, 'VIEWER')).toBe(false);
  });

  it('lets only an effective OWNER grant or change OWNER, and a platform administrator keep what an ADMIN reach allows', () => {
    expect(canGrantOwner('OWNER')).toBe(true);
    expect(canGrantOwner('ADMIN')).toBe(false);
    expect(canGrantOwner('MEMBER')).toBe(false);
    expect(canGrantOwner(null)).toBe(false);
    expect(canGrantOwner('ADMIN', true)).toBe(true);
    expect(canGrantOwner('MEMBER', true)).toBe(false);
    expect(canGrantOwner(null, true)).toBe(false);
  });

  it('reads a role as inherited when a visible ancestor already grants it, and as own when it is higher', () => {
    expect(roleSource(lab, all)).toMatchObject({
      kind: 'inherited',
      text: 'Inherited from ISA Demo Group',
    });
    expect(roleSource(group, all)).toEqual({ kind: 'own', text: 'Your own role' });

    const marco = org('qos-lab', { parent_id: group.id, effective_role: 'ADMIN' });
    const marcoGroup = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
    expect(roleSource(marco, [marco, marcoGroup])).toMatchObject({
      kind: 'own',
      text: 'Your own role here (higher than MEMBER inherited from ISA Demo Group)',
    });
  });
});

describe('the organization tree', () => {
  it('finds ancestors nearest first and descendants at any depth', () => {
    expect(ancestorsOf(side, all).map(item => item.slug)).toEqual(['qos-lab', 'isa-demo']);
    expect(
      descendantsOf(group, all)
        .map(item => item.slug)
        .sort()
    ).toEqual(['qos-lab', 'side']);
    expect(pathOf(side, all).map(item => item.slug)).toEqual(['isa-demo', 'qos-lab', 'side']);
  });

  it('starts a tree at an organization whose parent is not visible', () => {
    const forest = buildForest([lab, side]);
    expect(forest.map(node => node.organization.slug)).toEqual(['qos-lab']);
    expect(flatten(forest).map(node => [node.organization.slug, node.depth])).toEqual([
      ['qos-lab', 0],
      ['side', 1],
    ]);
  });
});

describe('names', () => {
  it('suggests an address from a name', () => {
    expect(slugFromName('Distributed Systems Lab')).toBe('distributed-systems-lab');
    expect(slugFromName('  Laboratorio de Cómputo — Sevilla  ')).toBe(
      'laboratorio-de-computo-sevilla'
    );
    expect(slugFromName('x'.repeat(80))).toHaveLength(64);
  });

  it('takes initials from the first two words and ignores a parenthesis', () => {
    expect(initialsOf('ISA Demo Group')).toBe('ID');
    expect(initialsOf('QoS Lab (sub-organización)')).toBe('QL');
    expect(initialsOf('Consultora')).toBe('CO');
  });

  it('gives an organization the same tile colour everywhere, never the light brand blue that fails with white initials', () => {
    expect(tileColour('isa-demo')).toBe(tileColour('isa-demo'));
    const used = new Set(
      ['isa-demo', 'qos-lab', 'partner-lab', 'read-lab', 'a', 'b', 'c', 'd', 'e'].map(tileColour)
    );
    expect([...used].every(colour => (TILE_COLOURS as readonly string[]).includes(colour))).toBe(
      true
    );
    expect(TILE_COLOURS).not.toContain('var(--tp-sunshine-800)');
  });
});
