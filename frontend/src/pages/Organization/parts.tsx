import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Organization, OrganizationRole } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Skeleton } from '../../components/ui/Skeleton';
import { initialsOf, tileColour } from './orgModel';
import '../../components/ui/FormField.css';
import './Organization.css';

/** A role as a small coloured label. `PLATFORM ADMIN` is not an organization role; it is shown to administrators. */
export function RoleChip({ role, title }: { role: OrganizationRole | 'PLATFORM ADMIN' | null; title?: string }) {
  if (!role) return <span className="org-role is-none" title={title}>No role</span>;
  return <span className={`org-role is-${role.toLowerCase().replace(' ', '-')}`} title={title}>{role}</span>;
}

/** The square initials of an organization. */
export function OrgTile({ organization, size = 'md' }: { organization: Pick<Organization, 'name' | 'slug'>; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`org-tile is-${size}`} style={{ background: tileColour(organization.slug) }} aria-hidden="true">
      {initialsOf(organization.name)}
    </span>
  );
}

export interface Crumb {
  label: string;
  to?: string;
}

/** `Home / Parent / This organization`: the last one is where you are. */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="org-crumbs">
      <ol>
        {items.map((item, index) => (
          <li key={`${item.label}:${index}`}>
            {index > 0 && <span aria-hidden="true">/</span>}
            {item.to && index < items.length - 1 ? <Link to={item.to} viewTransition>{item.label}</Link> : <span aria-current={index === items.length - 1 ? 'page' : undefined}>{item.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface GateProps {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}

/** A page-sized card that says why a screen is not shown. */
export function Gate({ title, children, action }: GateProps) {
  return (
    <div className="org-gate">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      <h2>{title}</h2>
      <p>{children}</p>
      {action && <div className="org-gate-actions">{action}</div>}
    </div>
  );
}

/**
 * The same message whether the organization does not exist or the person is not in it (gap L3 of the design
 * report): the answer must not reveal which organizations exist.
 */
export function NeutralGate({ withExplore = false }: { withExplore?: boolean }) {
  return (
    <Gate
      title="Organization not available"
      action={(
        <>
          <Action to="/app" variant="primary">Back to Home</Action>
          {withExplore && <Action to="/explore" variant="link">Explore public projects</Action>}
        </>
      )}
    >
      It doesn’t exist, or you’re not a member. We show the same message in both cases so organization names stay private.
    </Gate>
  );
}

interface ChoiceProps {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  label: ReactNode;
  sub?: ReactNode;
  /** The sub line explains why the choice is unavailable. */
  warn?: boolean;
  trailing?: ReactNode;
}

/** One option of a radio group, drawn as a card: a native radio, so arrow keys and screen readers work as usual. */
export function Choice({ name, value, checked, disabled, onChange, label, sub, warn, trailing }: ChoiceProps) {
  return (
    <label className={`org-choice${checked ? ' is-checked' : ''}${disabled ? ' is-disabled' : ''}`}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChange(value)} />
      <span className="org-choice-body">
        <strong>{label}</strong>
        {sub && <small className={warn ? 'is-warn' : undefined}>{sub}</small>}
      </span>
      {trailing}
    </label>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  hint?: string;
  maxWidth?: string;
}

/** A labelled select that looks like the text fields of `FormField`. */
export function SelectField({ label, value, onChange, children, disabled, hint, maxWidth }: SelectFieldProps) {
  const id = useId();
  return (
    <div className="ui-field" style={maxWidth ? { maxWidth } : undefined}>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} aria-describedby={hint ? `${id}-hint` : undefined}>
        {children}
      </select>
      {hint && <span id={`${id}-hint`} className="ui-field-note">{hint}</span>}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="org-skeleton" aria-busy="true" role="status">
      <span className="sr-only">Loading…</span>
      <Skeleton variant="panel" />
      <Skeleton variant="card" />
    </div>
  );
}
