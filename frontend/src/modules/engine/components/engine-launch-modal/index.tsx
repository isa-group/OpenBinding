// Where a run or a study with an engine starts: the account chooses the organization it belongs to with SPHERE's
// organization selector (members and above, who may launch), then lands on that organization's form with the engine named.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Action } from '../../../core/components/action-button';
import { Modal } from '../../../core/components/modal';
import type { Organization } from '../../../organization/api/organizationsApi';
import OrganizationSelector from '../../../organization/components/organization-selector';

interface Props {
  title: string;
  /** The button that continues. */
  actionLabel: string;
  /** What starts there. */
  noun: 'run' | 'study';
  /** Where the chosen organization's form is. */
  destination: (org: string) => string;
  onClose: () => void;
}

export default function EngineLaunchModal({
  title,
  actionLabel,
  noun,
  destination,
  onClose,
}: Props) {
  const navigate = useNavigate();
  const [org, setOrg] = useState<Organization | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-3 text-sm text-tp-slate">
        Choose the organization the {noun} belongs to. You need to be a member of it.
      </p>
      <OrganizationSelector value={org} onChange={setOrg} minRole="MEMBER" />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Action variant="secondary" onClick={onClose}>
          Cancel
        </Action>
        <Action
          variant="primary"
          disabled={!org}
          onClick={() => {
            if (org) void navigate(destination(org.slug));
          }}
        >
          {actionLabel}
        </Action>
      </div>
    </Modal>
  );
}
