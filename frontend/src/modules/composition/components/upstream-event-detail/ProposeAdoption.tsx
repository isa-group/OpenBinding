// "Propose adopting <version> in <environment>" on a resolved upstream event (F6): the version that resolved the event is
// not adopted where the affected version still is. The action makes an `adopt` proposal answering the event and shows it on
// its card, in a modal, for its author to confirm; adopting directly stays the adopt dialog's (D-f).

import { useState } from 'react';
import { readApiError } from '../../../core/api/errors';
import type {
  CompositionEnvironmentView,
  ProposalView,
  UpstreamEventDetail,
} from '../../../core/api/types';
import { Modal } from '../../../core/components/modal';
import type { OrgRole } from '../../../organization/api/organizationsApi';
import { useProposalsApi } from '../../api/proposalsApi';
import { roleAtLeast } from '../../hooks/useCompositionRole';
import ProposalPanel from '../proposals-section/ProposalPanel';

const actionClass =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs text-tp-ink transition-colors hover:bg-tp-surface focus:border-tp-primary focus:outline-none disabled:cursor-wait disabled:opacity-60';

interface Props {
  org: string;
  composition: string;
  event: UpstreamEventDetail;
  environments: CompositionEnvironmentView[];
  role: OrgRole | null;
  /** The proposal was applied: the tab reads what it shows again. */
  onChanged: () => void;
}

/** The environments still on the affected version where the reader may adopt the version that resolved the event. */
function targets(
  event: UpstreamEventDetail,
  environments: CompositionEnvironmentView[],
  role: OrgRole | null
) {
  const resolving = event.resolvedBy?.version;
  if (!resolving) return [];
  return environments.filter(
    environment =>
      event.environments.includes(environment.slug) &&
      environment.inEffect?.version.id !== resolving.id &&
      roleAtLeast(role, environment.adoptRole)
  );
}

export default function ProposeAdoption({
  org,
  composition,
  event,
  environments,
  role,
  onChanged,
}: Props) {
  const api = useProposalsApi();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const resolving = event.resolvedBy?.version;
  const offered = targets(event, environments, role);
  if (!resolving || offered.length === 0) return null;

  const propose = async (environment: CompositionEnvironmentView) => {
    setBusy(true);
    setFailure('');
    try {
      setProposal(
        await api.create(org, composition, {
          kind: 'adopt',
          environment: environment.slug,
          version: resolving.id,
          note: '',
          upstreamEvent: event.id,
        })
      );
    } catch (caught) {
      setFailure(readApiError(caught).message || 'The proposal couldn’t be made.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {offered.map(environment => (
        <button
          key={environment.slug}
          type="button"
          disabled={busy}
          onClick={() => void propose(environment)}
          className={actionClass}
        >
          {`Propose adopting ${resolving.label} in ${environment.slug}`}
        </button>
      ))}
      {failure && (
        <p role="alert" className="m-0 w-full text-xs text-red-700">
          {failure}
        </p>
      )}
      {proposal && (
        <Modal
          title="Adopt the version that resolved it"
          size="lg"
          onClose={() => setProposal(null)}
        >
          <div className="flex flex-col gap-3">
            <ProposalPanel
              proposal={proposal}
              context={{ org, composition, environments }}
              onChanged={changed => {
                if (changed) setProposal(changed);
                onChanged();
              }}
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setProposal(null)}
                className="cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-xs font-medium text-tp-ink hover:bg-tp-surface"
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
