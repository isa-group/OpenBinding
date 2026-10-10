import { describe, expect, it } from 'vitest';
import { catalogFixture } from '../Pricing/pricingFixture';
import {
  TILE_COLOURS, ancestorsOf, atLeast, buildForest, descendantsOf, flatten, initialsOf, pathOf, roleSource, slugFromName, sponsorName, tileColour,
} from './orgModel';
import { roomFromCatalog, roomFromUsage, roomText, roomTone } from './roomModel';
import { auditFixture } from './auditFixture';
import { changesOf, describeEvent, kindOf, toCsv } from './auditModel';
import { lucia, member, org, researchUsage } from './testKit';

const group = org('isa-demo', { name: 'ISA Demo Group' });
const lab = org('qos-lab', { name: 'QoS Lab (sub-organización)', parent_id: group.id, effective_role: 'OWNER' });
const side = org('side', { name: 'Side', parent_id: lab.id, effective_role: 'ADMIN' });
const all = [lab, side, group];

describe('roles', () => {
  it('compares roles by strength and treats a missing role as nothing', () => {
    expect(atLeast('ADMIN', 'ADMIN')).toBe(true);
    expect(atLeast('MEMBER', 'ADMIN')).toBe(false);
    expect(atLeast('OWNER', 'MEMBER')).toBe(true);
    expect(atLeast(null, 'VIEWER')).toBe(false);
  });

  it('reads a role as inherited when a visible ancestor already grants it, and as own when it is higher', () => {
    expect(roleSource(lab, all)).toMatchObject({ kind: 'inherited', text: 'Inherited from ISA Demo Group' });
    expect(roleSource(group, all)).toEqual({ kind: 'own', text: 'Your own role' });

    const marco = org('qos-lab', { parent_id: group.id, effective_role: 'ADMIN' });
    const marcoGroup = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
    expect(roleSource(marco, [marco, marcoGroup])).toMatchObject({ kind: 'own', text: 'Your own role here (higher than MEMBER inherited from ISA Demo Group)' });
  });
});

describe('the organization tree', () => {
  it('finds ancestors nearest first and descendants at any depth', () => {
    expect(ancestorsOf(side, all).map((item) => item.slug)).toEqual(['qos-lab', 'isa-demo']);
    expect(descendantsOf(group, all).map((item) => item.slug).sort()).toEqual(['qos-lab', 'side']);
    expect(pathOf(side, all).map((item) => item.slug)).toEqual(['isa-demo', 'qos-lab', 'side']);
  });

  it('starts a tree at an organization whose parent is not visible', () => {
    const forest = buildForest([lab, side]);
    expect(forest.map((node) => node.organization.slug)).toEqual(['qos-lab']);
    expect(flatten(forest).map((node) => [node.organization.slug, node.depth])).toEqual([['qos-lab', 0], ['side', 1]]);
  });
});

describe('names', () => {
  it('suggests an address from a name', () => {
    expect(slugFromName('Distributed Systems Lab')).toBe('distributed-systems-lab');
    expect(slugFromName('  Laboratorio de Cómputo — Sevilla  ')).toBe('laboratorio-de-computo-sevilla');
    expect(slugFromName('x'.repeat(80))).toHaveLength(64);
  });

  it('takes initials from the first two words and ignores a parenthesis', () => {
    expect(initialsOf('ISA Demo Group')).toBe('ID');
    expect(initialsOf('QoS Lab (sub-organización)')).toBe('QL');
    expect(initialsOf('Consultora')).toBe('CO');
  });

  it('gives an organization the same tile colour everywhere, never the light brand blue that fails with white initials', () => {
    expect(tileColour('isa-demo')).toBe(tileColour('isa-demo'));
    const used = new Set(['isa-demo', 'qos-lab', 'partner-lab', 'read-lab', 'a', 'b', 'c', 'd', 'e'].map(tileColour));
    expect([...used].every((colour) => (TILE_COLOURS as readonly string[]).includes(colour))).toBe(true);
    expect(TILE_COLOURS).not.toContain('var(--tp-sunshine-800)');
  });

  it('names the sponsor from the account, then from a member list', () => {
    const me = { id: lucia.id, username: lucia.username };
    expect(sponsorName(group, [], me)).toBe('lucia.vega (you)');
    const other = org('x', { billing_sponsor_user_id: 'user-nora' });
    expect(sponsorName(other, [member('nora', 'OWNER')], me)).toBe('nora');
    expect(sponsorName(other, [], me)).toBe('Another account');
  });
});

describe('the sponsor’s room', () => {
  it('reads used and limit from the sponsor’s own usage and marks what a change adds', () => {
    const rows = roomFromUsage(researchUsage(), ['organizations', 'members', 'projects'], { organizations: 1, members: 1 });
    expect(rows.map((row) => [row.label, row.used, row.limit, row.added])).toEqual([
      ['Organizations', 2, 5, 1], ['Unique members', 3, 15, 1], ['Projects', 3, 50, 0],
    ]);
    expect(roomText(rows[0])).toBe('3 of 5');
    expect(roomTone(rows[0])).toBe('ok');
  });

  it('warns at the limit and past it', () => {
    const usage = researchUsage();
    usage.limits.organizations = { ...usage.limits.organizations, used: 4 };
    expect(roomTone(roomFromUsage(usage, ['organizations'], { organizations: 1 })[0])).toBe('full');
    usage.limits.organizations = { ...usage.limits.organizations, used: 5 };
    expect(roomTone(roomFromUsage(usage, ['organizations'], { organizations: 1 })[0])).toBe('over');
  });

  it('falls back to the plan ceilings of the catalog when the usage of the sponsor is not visible', () => {
    const rows = roomFromCatalog(catalogFixture, 'PRO', ['organizations', 'members']);
    expect(rows.map((row) => [row.id, row.limit, row.used])).toEqual([['organizations', 10, null], ['members', 100, null]]);
    expect(roomText(rows[0])).toBe('Up to 10');
  });
});

describe('the audit log', () => {
  it('groups actions into kinds', () => {
    expect(kindOf('organization.created')).toBe('organization');
    expect(kindOf('organization.members.batch_updated')).toBe('members');
    expect(kindOf('organization.invitation.created')).toBe('members');
    expect(kindOf('project.deleted')).toBe('projects');
    expect(kindOf('binding_case.revision.created')).toBe('content');
    expect(kindOf('something.new')).toBe('other');
  });

  it('describes a batch by how many changes it applied and exposes them', () => {
    const [, batch] = auditFixture;
    expect(describeEvent(batch)).toBe('2 member changes applied together');
    expect(changesOf(batch)).toEqual([{ userId: 'user-marco', role: 'ADMIN' }, { userId: 'user-sofia', role: null }]);
  });

  it('exports plain CSV, quoting what needs it', () => {
    const csv = toCsv(auditFixture);
    const [head, first] = csv.split('\n');
    expect(head).toBe('id,createdAt,actorId,action,targetType,targetId,detail');
    expect(first.startsWith('ev-3,')).toBe(true);
    expect(csv).toContain('"{""changes"":');
  });
});
