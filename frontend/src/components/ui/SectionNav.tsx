import { Link } from 'react-router-dom';
import './SectionNav.css';

export interface SectionNavItem<Id extends string = string> {
  id: Id;
  label: string;
  to: string;
}

interface SectionNavProps<Id extends string> {
  label: string;
  items: ReadonlyArray<SectionNavItem<Id>>;
  current: Id;
  className?: string;
  /** Keep the current item a link (marked as current) instead of plain text. */
  linkCurrent?: boolean;
}

/** Pill navigation between the sections of an area; the current one is marked and, unless `linkCurrent`, is not a link. */
export function SectionNav<Id extends string>({ label, items, current, className, linkCurrent = false }: SectionNavProps<Id>) {
  return (
    <nav className={className ? `ui-section-nav ${className}` : 'ui-section-nav'} aria-label={label}>
      {items.map((item) => {
        if (item.id !== current) return <Link key={item.id} to={item.to}>{item.label}</Link>;
        return linkCurrent
          ? <Link key={item.id} to={item.to} aria-current="page">{item.label}</Link>
          : <span key={item.id} aria-current="page">{item.label}</span>;
      })}
    </nav>
  );
}

/** The sections of the Explore page, in order: the public work and the BIM examples. */
const EXPLORE_SECTIONS = [
  { id: 'public', label: 'Public work', to: '/explore' },
  { id: 'examples', label: 'BIM examples', to: '/explore/examples' },
] as const;

export type ExploreSection = (typeof EXPLORE_SECTIONS)[number]['id'];

/** Pill navigation between the sections of Explore; every section is a link and the current one is marked. */
export function ExploreNav({ current }: { current: ExploreSection }) {
  return <SectionNav label="Explore" items={EXPLORE_SECTIONS} current={current} linkCurrent />;
}
