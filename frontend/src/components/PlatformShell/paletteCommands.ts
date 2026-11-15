import type { Organization } from '../../api/platform';
import { accountLinks, createItems, mainLinks, organizationEntries } from './appNavigation';

export interface PaletteContext {
  organizations?: Organization[];
  organization?: Organization;
  isAdmin: boolean;
}

export interface Command {
  label: string;
  desc: string;
  href: string;
  group: string;
  glyph: string;
}

const glyphOf = (label: string) => label
  .replace(/[^\p{L}\p{N} ]/gu, '')
  .split(' ')
  .filter(Boolean)
  .slice(0, 2)
  .map((word, index) => (index === 0 ? word[0].toUpperCase() : word[0].toLowerCase()))
  .join('') || '·';

/** Everything the palette can reach comes from the screen map and from data the workspace already loaded. */
export function buildCommands({ organizations = [], organization, isAdmin }: PaletteContext): Command[] {
  const command = (group: string, label: string, desc: string, href: string, glyph = glyphOf(label)): Command => ({ group, label, desc, href, glyph });

  const commands: Command[] = [
    command('Go to', 'Home', 'Organizations and recent activity', mainLinks.home.to),
    command('Go to', 'Engines', 'Engines by exact identity', mainLinks.engines.to),
    command('Go to', 'Pricing', 'Plans, limits and add-ons', '/pricing'),
  ];

  for (const item of organizations) {
    commands.push(command('Organization', item.name, 'Organization', `/app/${item.slug}`));
  }
  if (organization) {
    const entries = Object.fromEntries(organizationEntries(organization).map((entry) => [entry.id, entry.to]));
    if (entries.problems) {
      commands.push(command('Organization', 'Problems', `Binding problems and their versions · ${organization.name}`, entries.problems));
      commands.push(command('Create', 'New problem', `Upload a BIM package in ${organization.name}`, `${entries.problems}?create=problem`, '+'));
    }
    if (entries.runs) {
      commands.push(command('Organization', 'Runs', `Every run of the organization · ${organization.name}`, entries.runs));
      commands.push(command('Create', 'New run', `Launch an engine run in ${organization.name}`, `${entries.runs}/new`, '+'));
    }
    if (entries.studies) {
      commands.push(command('Organization', 'Studies', `Problems × engines × parameters × seeds · ${organization.name}`, entries.studies));
    }
    const study = createItems(organization).find((entry) => entry.label === 'Study');
    if (study?.to) commands.push(command('Create', 'New study', `Compare engines on problems in ${organization.name}`, study.to, '+'));
    commands.push(command('Organization', 'Organization settings', `Name, members and audit · ${organization.name}`, `/app/${organization.slug}/settings`));
  }

  const accountDesc: Record<string, string> = {
    Profile: 'Your details and security', Plan: 'Your plan and the SPACE and SPHERE consoles', 'API keys': 'Keys for scripts and CI',
    Identities: 'Accounts you sign in with', Notifications: 'Everything sent to your account',
  };
  commands.push(
    command('Create', 'New organization', 'Problems, runs and studies with their members', '/app?create=organization', '+'),
    command('Create', 'New API key', 'Scoped key for scripts and CI', '/app/account/keys?create=key', '+'),
    command('Create', 'Register an engine', 'Publish an engine you operate', '/app/engines/new', '+'),
    ...accountLinks.map((link) => command('Account', link.label, accountDesc[link.label] ?? link.label, link.to)),
  );

  if (isAdmin) {
    commands.push(
      command('Admin', mainLinks.admin.label, 'Users, queues and system health', mainLinks.admin.to),
    );
  }
  return commands;
}
