import { Link } from 'react-router-dom';
import './SectionNav.css';

/** The four screens of the language area, in the order the prototype lists them. */
const LANGUAGE_SECTIONS = [
  { id: 'profiles', label: 'Profiles & dialects', to: '/language' },
  { id: 'schemas', label: 'Schemas', to: '/language/schemas/application' },
  { id: 'examples', label: 'Examples', to: '/examples' },
  { id: 'workbench', label: 'Workbench', to: '/workbench' },
] as const;

export type LanguageSection = (typeof LANGUAGE_SECTIONS)[number]['id'];

export type ProjectLibrarySection = 'library' | 'collections' | 'resources';

interface ProjectLibraryNavProps {
  current: ProjectLibrarySection;
  orgSlug: string;
  projectSlug: string;
}

/**
 * Pill navigation of the library inside a project: what the project uses, its collections, the older resources view, the
 * organization's library and the workbench. The current one is not a link.
 */
export function ProjectLibraryNav({ current, orgSlug, projectSlug }: ProjectLibraryNavProps) {
  const root = `/app/${orgSlug}/${projectSlug}`;
  const sections: ReadonlyArray<{ id: ProjectLibrarySection | 'organization' | 'workbench'; label: string; to: string }> = [
    { id: 'library', label: 'Library used here', to: `${root}/library` },
    { id: 'collections', label: 'Collections', to: `${root}/collections` },
    { id: 'resources', label: 'Project resources (older view)', to: `${root}/resources` },
    { id: 'organization', label: 'Organization library', to: `/app/${orgSlug}/library` },
    { id: 'workbench', label: 'Workbench', to: `${root}/workbench` },
  ];
  return (
    <nav className="ui-section-nav" aria-label="Library sections">
      {sections.map((section) => (
        section.id === current
          ? <span key={section.id} aria-current="page">{section.label}</span>
          : <Link key={section.id} to={section.to} viewTransition>{section.label}</Link>
      ))}
    </nav>
  );
}

/** Pill navigation between Profiles, Schemas, Examples and the Workbench; the current one is not a link. */
export function LanguageNav({ current }: { current: LanguageSection }) {
  return (
    <nav className="ui-section-nav" aria-label="Language sections">
      {LANGUAGE_SECTIONS.map((section) => (
        section.id === current
          ? <span key={section.id} aria-current="page">{section.label}</span>
          : <Link key={section.id} to={section.to}>{section.label}</Link>
      ))}
    </nav>
  );
}
