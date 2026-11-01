import { Link } from 'react-router-dom';
import './SectionNav.css';

/** The four screens of the language area, in the order the prototype lists them. */
const LANGUAGE_SECTIONS = [
  { id: 'profiles', label: 'Profiles & dialects', to: '/language' },
  { id: 'schemas', label: 'Schemas', to: '/language/schemas/application' },
  { id: 'examples', label: 'Examples', to: '/explore/examples' },
  { id: 'workbench', label: 'Workbench', to: '/workbench' },
] as const;

/** The sections of the Explore page, in order: the public work and the BIM examples. */
const EXPLORE_SECTIONS = [
  { id: 'public', label: 'Public work', to: '/explore' },
  { id: 'examples', label: 'BIM examples', to: '/explore/examples' },
] as const;

export type ExploreSection = (typeof EXPLORE_SECTIONS)[number]['id'];

/** Pill navigation between the sections of Explore; every section is a link and the current one is marked. */
// [impl->req~frontend-nav-examples-in-explore~1]
export function ExploreNav({ current }: { current: ExploreSection }) {
  return (
    <nav className="ui-section-nav" aria-label="Explore">
      {EXPLORE_SECTIONS.map((section) => (
        <Link key={section.id} to={section.to} aria-current={section.id === current ? 'page' : undefined}>{section.label}</Link>
      ))}
    </nav>
  );
}

export type LanguageSection = (typeof LANGUAGE_SECTIONS)[number]['id'];

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
