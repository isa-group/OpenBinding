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
}

/** Pill navigation between the sections of an area; the current one is marked and is not a link. */
export function SectionNav<Id extends string>({ label, items, current, className }: SectionNavProps<Id>) {
  return (
    <nav className={className ? `ui-section-nav ${className}` : 'ui-section-nav'} aria-label={label}>
      {items.map((item) => {
        if (item.id !== current) return <Link key={item.id} to={item.to}>{item.label}</Link>;
        return <span key={item.id} aria-current="page">{item.label}</span>;
      })}
    </nav>
  );
}
