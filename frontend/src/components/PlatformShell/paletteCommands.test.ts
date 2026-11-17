import { describe, expect, it } from 'vitest';
import type { Organization } from '../../api/platform';
import { buildCommands } from './paletteCommands';

const organization: Organization = {
  id: 'org-1',
  slug: 'isa-demo',
  name: 'ISA demo',
  parent_id: null,
  effective_role: 'OWNER',
  created_at: '2026-01-01T00:00:00Z',
};

describe('buildCommands', () => {
  it('offers no command for a retired address, with data loaded and an administrator', () => {
    const commands = buildCommands({ organizations: [organization], organization, isAdmin: true });

    expect(commands.length).toBeGreaterThan(19);
    expect(commands.filter(command => command.label === 'Analysis')).toEqual([]);
    expect(commands.filter(command => /^\/app\/analysis([/?#]|$)/.test(command.href))).toEqual([]);
    expect(commands.map(command => command.href)).toContain('/app/isa-demo/studies');
  });

  it('offers no Reports, Publications, Published or Explore command', () => {
    const commands = buildCommands({ organizations: [organization], organization, isAdmin: false });

    expect(
      commands.filter(command =>
        ['Reports', 'Publications', 'Published', 'Explore'].includes(command.label)
      )
    ).toEqual([]);
    expect(
      commands.filter(command =>
        /\/(reports|publications|published|explore)([/?#]|$)/.test(command.href)
      )
    ).toEqual([]);
  });

  it('offers no Files or project command, and the settings of the organization', () => {
    const commands = buildCommands({ organizations: [organization], organization, isAdmin: false });

    expect(
      commands.filter(
        command => command.label === 'Files' || /\/(files|package)([/?#]|$)/.test(command.href)
      )
    ).toEqual([]);
    expect(
      commands.filter(command =>
        /project/i.test(`${command.label} ${command.desc} ${command.group}`)
      )
    ).toEqual([]);
    expect(
      commands
        .filter(command => command.label === 'Organization settings')
        .map(command => command.href)
    ).toEqual(['/app/isa-demo/settings']);
  });

  it('offers no Library or Collections command, and no library, resources or collections command anywhere', () => {
    const inOrganizationToo = buildCommands({
      organizations: [organization],
      organization,
      isAdmin: true,
    });
    const without = buildCommands({ organizations: [organization], isAdmin: true });

    expect(
      inOrganizationToo.filter(command =>
        ['Library', 'Collections', 'New collection'].includes(command.label)
      )
    ).toEqual([]);
    for (const commands of [inOrganizationToo, without]) {
      expect(
        commands.filter(command => /\/(library|resources|collections)([/?#]|$)/.test(command.href))
      ).toEqual([]);
    }
  });

  it('opens the New API key dialog of the API keys page, not a page of its own', () => {
    const commands = buildCommands({ organizations: [organization], isAdmin: false });

    expect(
      commands.filter(command => command.label === 'New API key').map(command => command.href)
    ).toEqual(['/me/api-keys?create=key']);
    expect(commands.filter(command => /\/app\/account([/?#]|$)/.test(command.href))).toEqual([]);
  });

  it('opens the New organization dialog of the workspace home', () => {
    const commands = buildCommands({ organizations: [organization], isAdmin: false });

    expect(
      commands.filter(command => command.label === 'New organization').map(command => command.href)
    ).toEqual(['/orgs/new']);
    expect(
      commands.filter(command => /^\/app\/organizations\/new([/?#]|$)/.test(command.href))
    ).toEqual([]);
  });

  it('has no Tools group and goes where the header goes', () => {
    const commands = buildCommands({ organizations: [organization], organization, isAdmin: false });
    const goTo = commands.filter(command => command.group === 'Go to');

    expect(commands.filter(command => command.group === 'Tools')).toEqual([]);
    expect(goTo.map(command => [command.label, command.href])).toEqual([
      ['Home', '/'],
      ['Engines', '/engines'],
      ['Pricing', '/pricing'],
      ['Problem editor', '/problem-editor'],
    ]);
    expect(
      commands.filter(command =>
        ['Jobs', 'Verify', 'Verifier', 'Engine catalog', 'My engines', 'Workbench'].includes(
          command.label
        )
      )
    ).toEqual([]);
    expect(
      commands.filter(command => command.label === 'Problems').map(command => command.href)
    ).toEqual(['/orgs/isa-demo/problems']);
  });

  it('offers the compositions of the organization and New composition, and neither without one', () => {
    const inOrganization = buildCommands({
      organizations: [organization],
      organization,
      isAdmin: false,
    });
    const without = buildCommands({ organizations: [organization], isAdmin: false });

    expect(
      inOrganization
        .filter(command => command.label === 'Compositions')
        .map(command => command.href)
    ).toEqual(['/orgs/isa-demo/compositions']);
    expect(
      inOrganization
        .filter(command => command.label === 'New composition')
        .map(command => [command.group, command.href])
    ).toEqual([['Create', '/compositions/new?org=isa-demo']]);
    expect(without.filter(command => /composition/i.test(command.label))).toEqual([]);
  });

  it('offers New problem, New run and New study in the organization, and none without one', () => {
    const inOrganizationToo = buildCommands({
      organizations: [organization],
      organization,
      isAdmin: false,
    });
    const inOrganization = buildCommands({
      organizations: [organization],
      organization,
      isAdmin: false,
    });
    const without = buildCommands({ organizations: [organization], isAdmin: false });
    const created = (commands: typeof inOrganizationToo) =>
      commands
        .filter(command => /^New (problem|collection|study|run)$/.test(command.label))
        .map(command => [command.label, command.href]);

    expect(created(inOrganizationToo)).toEqual([
      ['New problem', '/problem-editor?org=isa-demo'],
      ['New run', '/app/isa-demo/runs/new'],
      ['New study', '/app/isa-demo/studies/new'],
    ]);
    expect(created(inOrganization)).toEqual(created(inOrganizationToo));
    expect(
      inOrganization.filter(command => command.label === 'Runs').map(command => command.href)
    ).toEqual(['/app/isa-demo/runs']);
    expect(
      inOrganization.filter(command => command.label === 'Studies').map(command => command.href)
    ).toEqual(['/app/isa-demo/studies']);
    expect(created(without)).toEqual([]);
    expect(
      inOrganizationToo.filter(
        command => command.label === 'New job' || command.label === 'New case'
      )
    ).toEqual([]);
  });

  it('names the account commands as the account menu does', () => {
    const commands = buildCommands({ organizations: [organization], isAdmin: false });
    const account = commands.filter(command => command.group === 'Account');

    expect(account.map(command => [command.label, command.href])).toEqual([
      ['Settings', '/me/settings'],
      ['Plan', '/me/settings?section=plan'],
      ['API keys', '/me/api-keys'],
      ['Sign-in & Security', '/me/settings?section=integrations'],
      ['Notifications', '/me/settings?section=notifications'],
      ['Appearance', '/me/settings?section=appearance'],
    ]);
    expect(
      commands.filter(
        command => command.label === 'Account' || command.label === 'Plan & permissions'
      )
    ).toEqual([]);
  });

  it('offers no report command without an organization either', () => {
    const commands = buildCommands({ organizations: [organization], isAdmin: true });

    expect(
      commands.filter(
        command => command.label === 'Reports' || /\/reports([/?#]|$)/.test(command.href)
      )
    ).toEqual([]);
  });
});
