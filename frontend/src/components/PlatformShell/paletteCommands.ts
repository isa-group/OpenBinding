import type { Organization, Project } from '../../api/platform';
import { accountLinks, createItems, labEntries, labLinks, mainLinks, problemsEntry, projectRoot } from './appNavigation';

export interface PaletteContext {
  organizations?: Organization[];
  projects?: Project[];
  organization?: Organization;
  project?: Project;
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
export function buildCommands({ organizations = [], projects = [], organization, project, isAdmin }: PaletteContext): Command[] {
  const command = (group: string, label: string, desc: string, href: string, glyph = glyphOf(label)): Command => ({ group, label, desc, href, glyph });
  const root = projectRoot(organization, project);

  const commands: Command[] = [
    command('Go to', 'Home', 'Organizations and recent activity', mainLinks.home.to),
    command('Go to', 'Runs', 'Every run you can see', labLinks.runs.to),
    command('Go to', 'Generator', 'Generate benchmark instances', labLinks.generator.to),
    command('Go to', 'Engines', 'Engines by exact identity', mainLinks.engines.to),
    command('Go to', 'Pricing', 'Plans, limits and add-ons', '/pricing'),
  ];

  for (const item of organizations) {
    commands.push(command('Organization', item.name, 'Organization', `/app/${item.slug}`));
  }
  for (const item of projects) {
    const owner = organizations.find((entry) => entry.id === item.organization_id);
    if (owner) commands.push(command('Project', item.name, `Project in ${owner.name}`, `/app/${owner.slug}/${item.slug}`));
  }
  if (root && project) {
    const problems = problemsEntry(organization, project);
    const studies = labEntries(organization, project).find((entry) => entry.id === 'studies');
    const sections: Array<[string, string, string | undefined]> = [
      ['Problems', 'Binding problems and their versions', problems.to],
      ['Collections', 'Problems grouped into suites', `${root}/collections`],
      ['Studies', 'Problems × engines × parameters × seeds', studies?.to],
      ['Project settings', 'Name, visibility, members and package', `${root}/settings`],
    ];
    for (const [label, desc, href] of sections) {
      if (href) commands.push(command('Project', label, `${desc} · ${project.name}`, href));
    }
    const where = `in ${project.name}`;
    const created = createItems(organization, project);
    const describe: Record<string, string> = {
      Problem: 'Add a binding problem', Collection: 'Group problems into a suite', Study: 'Compare engines on problems', Run: 'Launch an engine run',
    };
    for (const item of created) {
      if (item.to) commands.push(command('Create', `New ${item.label.toLowerCase()}`, `${describe[item.label]} ${where}`, item.to, '+'));
    }
  }

  const accountDesc: Record<string, string> = {
    Profile: 'Your details and security', Plan: 'Your plan and the SPACE and SPHERE consoles', 'API keys': 'Keys for scripts and CI',
    Identities: 'Accounts you sign in with', Notifications: 'Everything sent to your account',
  };
  commands.push(
    command('Create', 'New organization', 'Group projects and members', '/app?create=organization', '+'),
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
