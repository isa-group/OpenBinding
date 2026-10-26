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
