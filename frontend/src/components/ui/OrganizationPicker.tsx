import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { platformApi, type Organization } from '../../api/platform';
import { useResource } from '../../utils/useResource';
// The organization picker (styles in OrganizationPicker.css).
import './OrganizationPicker.css';

interface LinkListProps {
  /** The default: a button that opens the organizations as links. */
  mode?: 'links';
  /** The button label: "Save to an organization", "Run with this engine". */
  label: string;
  /** Where an organization leads to. */
  destination: (organization: string) => string;
  variant?: 'primary' | 'secondary';
}

interface SelectProps {
  /** The organizations as a choice, one at a time: the slug of the chosen one is `value`. */
  mode: 'select';
  /** The question the choice answers: "Fork into". */
  label: string;
  /** The slug of the chosen organization, or null while none is. */
  value: string | null;
  onChange: (organization: Organization) => void;
  /** Why an organization cannot be chosen, said beside it; null when it can. */
  disabledReason?: (organization: Organization) => string | null;
}

export type OrganizationPickerProps = LinkListProps | SelectProps;

type Load =
  { status: 'idle' | 'loading' | 'failed' } | { status: 'ready'; options: Organization[] };

function useOrganizations() {
  const [load, setLoad] = useState<Load>({ status: 'idle' });
  const fetchOrganizations = () => {
    setLoad({ status: 'loading' });
    platformApi.organizations().then(
      options => setLoad({ status: 'ready', options }),
      () => setLoad({ status: 'failed' })
    );
  };
  return { load, fetchOrganizations };
}

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <span role="alert">
      Your organizations couldn’t be loaded.{' '}
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </span>
  );
}

const NONE = (
  <span>
    You’re in no organization yet. <Link to="/app">Open your workspace</Link> to create one.
  </span>
);

/**
 * A button that opens a short list of the organizations the signed-in account belongs to, each a link to `destination(organization)`.
 * Actions that need an organization (save a package as a problem, run) start here instead of guessing which one the person means.
 */
function OrganizationLinks({ label, destination, variant = 'secondary' }: LinkListProps) {
  const [open, setOpen] = useState(false);
  const { load, fetchOrganizations } = useOrganizations();
  const panelId = useId();

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && load.status !== 'ready' && load.status !== 'loading') fetchOrganizations();
  };

  return (
    <div className="ui-org-picker">
      <button
        type="button"
        className={`ui-org-picker-button is-${variant}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        {label}
      </button>
      {open && (
        <div
          className="ui-org-picker-panel"
          id={panelId}
          role="group"
          aria-label={`${label}: choose an organization`}
        >
          <span className="ui-org-picker-title">Choose an organization</span>
          {load.status === 'loading' && <span role="status">Loading your organizations…</span>}
          {load.status === 'failed' && <Failed onRetry={fetchOrganizations} />}
          {load.status === 'ready' && load.options.length === 0 && NONE}
          {load.status === 'ready' && load.options.length > 0 && (
            <ul>
              {load.options.map(organization => (
                <li key={organization.slug}>
                  <Link to={destination(organization.slug)}>
                    <strong>{organization.name}</strong>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The organizations of the signed-in account as one choice (radio buttons), read when it appears. An organization that cannot be
 * chosen stays listed, disabled, with the reason beside it, so the person sees why it is not offered.
 */
function OrganizationSelect({ label, value, onChange, disabledReason }: SelectProps) {
  const load = useResource('organization-picker:select', () => platformApi.organizations());
  const ids = useId();
  const options = load.data ?? [];

  return (
    <fieldset className="ui-org-select">
      <legend>{label}</legend>
      {load.status === 'loading' && <span role="status">Loading your organizations…</span>}
      {load.status === 'error' && <Failed onRetry={load.reload} />}
      {load.status === 'ready' && options.length === 0 && NONE}
      {options.length > 0 && (
        <ul>
          {options.map((organization, index) => {
            const reason = disabledReason?.(organization) ?? null;
            const reasonId = `${ids}-${index}`;
            return (
              <li
                key={organization.slug}
                className={
                  reason ? 'is-disabled' : value === organization.slug ? 'is-checked' : undefined
                }
              >
                <label>
                  <input
                    type="radio"
                    name={`${ids}-organization`}
                    value={organization.slug}
                    checked={value === organization.slug}
                    disabled={reason !== null}
                    aria-describedby={reason ? reasonId : undefined}
                    onChange={() => onChange(organization)}
                  />
                  <strong>{organization.name}</strong>
                </label>
                {reason && <small id={reasonId}>{reason}</small>}
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}

/**
 * The organizations of the signed-in account: as links behind a button (the default), or as one choice (`mode="select"`) with the
 * reason each unavailable one cannot be chosen.
 */
export function OrganizationPicker(props: OrganizationPickerProps) {
  return props.mode === 'select' ? (
    <OrganizationSelect {...props} />
  ) : (
    <OrganizationLinks {...props} />
  );
}
