import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { platformApi, type Organization } from '../../api/platform';
// The organization picker (styles in OrganizationPicker.css).
import './OrganizationPicker.css';

interface OrganizationPickerProps {
  /** The button label: "Save to an organization", "Run with this engine". */
  label: string;
  /** Where an organization leads to. */
  destination: (organization: string) => string;
  variant?: 'primary' | 'secondary';
}

type Load = { status: 'idle' | 'loading' | 'failed' } | { status: 'ready'; options: Organization[] };

/**
 * A button that opens a short list of the organizations the signed-in account belongs to, each a link to `destination(organization)`.
 * Actions that need an organization (save a package as a problem, run) start here instead of guessing which one the person means.
 */
export function OrganizationPicker({ label, destination, variant = 'secondary' }: OrganizationPickerProps) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ status: 'idle' });
  const panelId = useId();

  const fetchOrganizations = () => {
    setLoad({ status: 'loading' });
    platformApi.organizations().then(
      (options) => setLoad({ status: 'ready', options }),
      () => setLoad({ status: 'failed' }),
    );
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && load.status !== 'ready' && load.status !== 'loading') fetchOrganizations();
  };

  return (
    <div className="ui-org-picker">
      <button type="button" className={`ui-org-picker-button is-${variant}`} aria-expanded={open} aria-controls={panelId} onClick={toggle}>
        {label}
      </button>
      {open && (
        <div className="ui-org-picker-panel" id={panelId} role="group" aria-label={`${label}: choose an organization`}>
          <span className="ui-org-picker-title">Choose an organization</span>
          {load.status === 'loading' && <span role="status">Loading your organizations…</span>}
          {load.status === 'failed' && (
            <span role="alert">
              Your organizations couldn’t be loaded. <button type="button" onClick={fetchOrganizations}>Retry</button>
            </span>
          )}
          {load.status === 'ready' && load.options.length === 0 && (
            <span>You’re in no organization yet. <Link to="/app">Open your workspace</Link> to create one.</span>
          )}
          {load.status === 'ready' && load.options.length > 0 && (
            <ul>
              {load.options.map((organization) => (
                <li key={organization.slug}>
                  <Link to={destination(organization.slug)}><strong>{organization.name}</strong></Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
