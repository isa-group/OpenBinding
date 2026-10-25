import { describe, expect, it } from 'vitest';
import type { Organization, Project } from '../../api/platform';
import { buildCommands } from './paletteCommands';

const organization: Organization = {
  id: 'org-1', slug: 'isa-demo', name: 'ISA demo', parent_id: null, billing_sponsor_user_id: 'user-1',
  effective_role: 'OWNER', created_at: '2026-01-01T00:00:00Z',
};
const project: Project = {
  id: 'project-1', organization_id: 'org-1', slug: 'qos-benchmarks', name: 'QoS benchmarks', description: '',
  visibility: 'private', created_by_id: 'user-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

describe('buildCommands', () => {
  // [utest->req~frontend-retire-palette~1]
  it('offers no command for a retired address, with data loaded and an administrator', () => {
    const commands = buildCommands({ organizations: [organization], projects: [project], organization, project, isAdmin: true });

    expect(commands.length).toBeGreaterThan(20);
    expect(commands.filter((command) => command.label === 'Analysis')).toEqual([]);
    expect(commands.filter((command) => /^\/app\/analysis([/?#]|$)/.test(command.href))).toEqual([]);
    expect(commands.map((command) => command.href)).toContain('/app/isa-demo/qos-benchmarks/studies');
  });
});
