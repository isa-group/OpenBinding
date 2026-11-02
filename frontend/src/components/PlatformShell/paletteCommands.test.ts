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

  // [utest->req~frontend-retire-reports-navigation~1]
  // [utest->req~frontend-nav-project-tabs~1]
  it('offers Published instead of Reports and Publications in a project', () => {
    const commands = buildCommands({ organizations: [organization], projects: [project], organization, project, isAdmin: false });

    expect(commands.filter((command) => command.label === 'Reports' || command.label === 'Publications')).toEqual([]);
    expect(commands.filter((command) => /\/(reports|publications)([/?#]|$)/.test(command.href))).toEqual([]);
    const published = commands.filter((command) => command.label === 'Published');
    expect(published.map((command) => [command.group, command.href])).toEqual([['Project', '/app/isa-demo/qos-benchmarks/published']]);
    expect(published[0]?.desc).toContain('QoS benchmarks');
  });

  // [utest->req~frontend-nav-files-retired~1]
  it('offers no Files command and keeps the package with the project settings', () => {
    const commands = buildCommands({ organizations: [organization], projects: [project], organization, project, isAdmin: false });

    expect(commands.filter((command) => command.label === 'Files' || /\/(files|package)([/?#]|$)/.test(command.href))).toEqual([]);
    expect(commands.filter((command) => command.label === 'Project settings').map((command) => command.href)).toEqual(['/app/isa-demo/qos-benchmarks/settings']);
  });

  // [utest->req~frontend-retire-library-navigation~1]
  it('offers Collections instead of Library in a project, and no library or resources command anywhere', () => {
    const inProject = buildCommands({ organizations: [organization], projects: [project], organization, project, isAdmin: true });
    const without = buildCommands({ organizations: [organization], isAdmin: true });

    expect(inProject.filter((command) => command.label === 'Library')).toEqual([]);
    const collections = inProject.filter((command) => command.label === 'Collections');
    expect(collections.map((command) => [command.group, command.href])).toEqual([['Project', '/app/isa-demo/qos-benchmarks/collections']]);
    expect(collections[0]?.desc).toMatch(/^Problems grouped into suites/);
    expect(collections[0]?.desc).toContain('QoS benchmarks');
    for (const commands of [inProject, without]) {
      expect(commands.filter((command) => /\/(library|resources)([/?#]|$)/.test(command.href))).toEqual([]);
    }
  });

  // [utest->req~frontend-nav-account-sections~1]
  it('opens the New API key dialog of the API keys section, not the moved address', () => {
    const commands = buildCommands({ organizations: [organization], isAdmin: false });

    expect(commands.filter((command) => command.label === 'New API key').map((command) => command.href)).toEqual(['/app/account/keys?create=key']);
    expect(commands.filter((command) => /^\/app\/account\/keys\/new([/?#]|$)/.test(command.href))).toEqual([]);
  });

  // [utest->req~frontend-nav-create-dialogs~1]
  it('opens the New organization dialog of the workspace home, not the moved address', () => {
    const commands = buildCommands({ organizations: [organization], isAdmin: false });

    expect(commands.filter((command) => command.label === 'New organization').map((command) => command.href)).toEqual(['/app?create=organization']);
    expect(commands.filter((command) => /^\/app\/organizations\/new([/?#]|$)/.test(command.href))).toEqual([]);
  });

  // [utest->req~frontend-nav-signed-in-navigation~1]
  it('has no Tools group and goes where the header goes', () => {
    const commands = buildCommands({ organizations: [organization], projects: [project], organization, project, isAdmin: false });
    const goTo = commands.filter((command) => command.group === 'Go to');

    expect(commands.filter((command) => command.group === 'Tools')).toEqual([]);
    expect(goTo.map((command) => [command.label, command.href])).toEqual([
      ['Home', '/app'], ['Runs', '/app/jobs'], ['Generator', '/app/generator'], ['Engines', '/engines'], ['Language', '/language'],
      ['Explore', '/explore'], ['Verify', '/verify'], ['Pricing', '/pricing'],
    ]);
    expect(commands.filter((command) => ['Jobs', 'Verifier', 'Engine catalog', 'My engines', 'Generator lab', 'Workbench'].includes(command.label))).toEqual([]);
    expect(commands.filter((command) => command.label === 'Problems').map((command) => command.href)).toEqual(['/app/isa-demo/qos-benchmarks/problems']);
  });

  // [utest->req~frontend-nav-new-menu~1]
  it('offers New problem, collection, study and run in the current project, and none without one', () => {
    const inProject = buildCommands({ organizations: [organization], projects: [project], organization, project, isAdmin: false });
    const without = buildCommands({ organizations: [organization], isAdmin: false });
    const created = (commands: typeof inProject) => commands
      .filter((command) => /^New (problem|collection|study|run)$/.test(command.label)).map((command) => [command.label, command.href]);

    expect(created(inProject)).toEqual([
      ['New problem', '/app/isa-demo/qos-benchmarks/problems?create=problem'],
      ['New collection', '/app/isa-demo/qos-benchmarks/collections?create=collection'],
      ['New study', '/app/isa-demo/qos-benchmarks/studies/new'],
      ['New run', '/app/isa-demo/qos-benchmarks/jobs/new'],
    ]);
    expect(created(without)).toEqual([]);
    expect(inProject.filter((command) => command.label === 'New job' || command.label === 'New case')).toEqual([]);
  });

  // [utest->req~frontend-nav-account-menu~1]
  it('names the account commands as the account menu does', () => {
    const commands = buildCommands({ organizations: [organization], isAdmin: false });
    const account = commands.filter((command) => command.group === 'Account');

    expect(account.map((command) => [command.label, command.href])).toEqual([
      ['Profile', '/app/account'], ['Plan', '/app/account/usage'], ['API keys', '/app/account/keys'],
      ['Identities', '/app/account/identities'], ['Notifications', '/app/account/notifications'],
    ]);
    expect(commands.filter((command) => command.label === 'Account' || command.label === 'Plan & permissions')).toEqual([]);
  });

  // [utest->req~frontend-retire-reports-navigation~1]
  it('offers no report command without a project either', () => {
    const commands = buildCommands({ organizations: [organization], isAdmin: true });

    expect(commands.filter((command) => command.label === 'Reports' || /\/reports([/?#]|$)/.test(command.href))).toEqual([]);
  });
});
