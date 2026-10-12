import type { Organization, Project } from '../../api/platform';

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
  const root = organization && project ? `/app/${organization.slug}/${project.slug}` : undefined;

  const commands: Command[] = [
    command('Go to', 'Home', 'Organizations and recent activity', '/app'),
    command('Go to', 'Jobs', 'Every job you can see', '/app/jobs'),
    command('Go to', 'Analysis', 'Compare sources of binding decisions', '/app/analysis'),
    command('Go to', 'Explore', 'Public projects, publications and engines', '/explore'),
    command('Go to', 'Engine catalog', 'Engines by exact identity', '/engines'),
    command('Go to', 'Language: profiles & dialects', 'How instances become binding problems', '/language'),
    command('Go to', 'Workbench', 'Validate a .bim.zip package', '/workbench'),
    command('Go to', 'Pricing', 'Plans, limits and add-ons', '/pricing'),
    command('Tools', 'Verifier', 'Resolve a digest and check its provenance', '/app/verifier'),
    command('Tools', 'My engines', 'Engines registered by your account', '/app/engines/registrations'),
    command('Tools', 'Language extensions', 'Dialects and profiles you maintain', '/app/language/extensions'),
    command('Tools', 'Generator lab', 'Generate benchmark instances', '/app/generator'),
  ];

  for (const item of organizations) {
    commands.push(command('Organization', item.name, 'Organization', `/app/${item.slug}`));
  }
  for (const item of projects) {
    const owner = organizations.find((entry) => entry.id === item.organization_id);
    if (owner) commands.push(command('Project', item.name, `Project in ${owner.name}`, `/app/${owner.slug}/${item.slug}`));
  }
  if (root && project) {
    const sections: Array<[string, string, string]> = [
      ['Cases', 'Binding cases and their revisions', '/cases'],
      ['Library', 'Versioned artifacts and drafts', '/library'],
      ['Files', 'Files stored in this project', '/files'],
      ['Studies', 'Cases × engines × parameters × seeds', '/studies'],
      ['Reports', 'Frozen, reproducible evidence', '/reports'],
      ['Project settings', 'Name, visibility and members', '/settings'],
    ];
    for (const [label, desc, suffix] of sections) {
      commands.push(command('Project', label, `${desc} · ${project.name}`, `${root}${suffix}`));
    }
    commands.push(command('Create', 'New job', `Launch an engine run in ${project.name}`, `${root}/jobs/new`, '+'));
  }

  commands.push(
    command('Create', 'New organization', 'Group projects and members', '/app/organizations/new', '+'),
    command('Create', 'New API key', 'Scoped key for scripts and CI', '/app/account/keys/new', '+'),
    command('Create', 'Register an engine', 'Publish an engine you operate', '/app/engines/new', '+'),
    command('Account', 'Account', 'Profile and security', '/app/account'),
    command('Account', 'Usage & plan', 'Quotas left this month', '/app/account/usage'),
    command('Account', 'API keys', 'Keys for scripts and CI', '/app/account/keys'),
    command('Account', 'Notifications', 'Everything sent to your account', '/app/account/notifications'),
  );

  if (isAdmin) {
    commands.push(
      command('Admin', 'Administration', 'Users, queues and system health', '/app/admin'),
    );
  }
  return commands;
}
