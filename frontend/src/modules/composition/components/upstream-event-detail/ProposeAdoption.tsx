// "Propose adopting <version> in <environment>" on a resolved upstream event (F6): the version that resolved the event is
// not adopted where the affected version still is. The action makes an `adopt` proposal answering the event and shows it on
// its card, in a modal, for its author to confirm; adopting directly stays the adopt dialog's (D-f).

import { useEffect, useRef, useState } from 'react';
import { readApiError } from '../../../core/api/errors';
import { proposalErrors } from '../../../core/api/problem';
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
  /** Put focus somewhere that stays (the event's heading) when the modal closes with no button left to return to. */
  onFocusAway?: () => void;
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
  onFocusAway,
}: Props) {
  const api = useProposalsApi();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const resolving = event.resolvedBy?.version;
  const offered = targets(event, environments, role);
  // Closed after its adoption left nothing to offer: the opener is gone, so focus goes where the page says.
  const closedAway = useRef(false);
  useEffect(() => {
    if (proposal || !closedAway.current) return;
    closedAway.current = false;
    onFocusAway?.();
  }, [proposal, onFocusAway]);
  const close = () => {
    closedAway.current = offered.length === 0;
    setProposal(null);
  };
  // An open proposal keeps its card (and its outcome) on screen after the adoption it applied leaves nothing to offer.
  if (!resolving || (offered.length === 0 && !proposal)) return null;

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
      // A 422 says why in its `errors` (the version is already in effect there, the environment is gone…).
      const reasons = proposalErrors(caught)
        .map(item => item.message)
        .filter(Boolean);
      setFailure(
        reasons.length > 0
          ? `The proposal couldn’t be made: ${reasons.join(' ')}`
          : readApiError(caught).message || 'The proposal couldn’t be made.'
      );
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
        <Modal title="Adopt the version that resolved it" size="lg" onClose={close}>
          <div className="flex flex-col gap-3">
            <p className="m-0 text-xs text-tp-steel" role="status">
              Nothing is adopted until you confirm. The proposal waits on the Operation tab until
              you confirm or cancel it, or until you make another one on this composition, which
              replaces it.
            </p>
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
                onClick={close}
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
