import { useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { SponsorProposal } from '../../api/auth';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { expiryText, proposerName, sponsorRefusal } from '../Organization/sponsorModel';
import { NOTIFICATIONS_UPDATED } from './notificationsModel';

type Answer = 'accept' | 'decline';

/** The header bell and the counters refresh from this event. */
function announceChange() {
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_UPDATED));
}

function AnswerDialog({ proposal, answer, plan, onClose, onDone }: {
  proposal: SponsorProposal;
  answer: Answer;
  plan: string | undefined;
  onClose: () => void;
  onDone: (result: SponsorProposal) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; retry: boolean } | null>(null);
  const accepting = answer === 'accept';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = accepting ? await apiClient.acceptSponsorProposal(proposal.id) : await apiClient.declineSponsorProposal(proposal.id);
      onDone(result);
    } catch (caught) {
      const refusal = sponsorRefusal(caught, answer);
      setError({ text: refusal.text, retry: refusal.retry });
      setBusy(false);
    }
  };

  return (
    <Modal title={accepting ? `Sponsor ${proposal.organization_name}?` : `Decline sponsoring ${proposal.organization_name}?`} size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => void submit(event)}>
        {accepting ? (
          <>
            <p>
              If you accept, the consumption of <strong>{proposal.organization_name}</strong> and everything under it — members, projects, storage and the rest —
              passes to <strong>your quota</strong> and is limited by <strong>your plan</strong>{plan ? ` (${plan})` : ''}, together with what you already sponsor.
            </p>
            <p className="acct-muted">
              Your plan’s limits are checked when you accept. If they don’t fit, nothing changes and the request stays open, so you can accept again after raising your plan.
            </p>
          </>
        ) : (
          <p>
            Nothing changes: {proposal.organization_name} keeps its current sponsor, and {proposerName(proposal)} is told you declined.
          </p>
        )}
        <div aria-live="assertive">
          {error && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{error.text}</div>}
        </div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant={accepting ? 'primary' : 'danger'} busy={busy}>
            {error?.retry ? 'Try again' : accepting ? 'Accept and sponsor' : 'Decline request'}
          </Action>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The sponsor requests addressed to the signed-in account. Nobody can make another person pay: a request does nothing until its
 * person accepts here (or declines). Hidden while there is none, so the notifications read as before.
 */
export function SponsorRequestsForYou() {
  const { user } = useAuth();
  const requests = useResource<SponsorProposal[] | null>(`sponsor-requests-for-you:${user?.id ?? ''}`, async () => {
    try {
      return await apiClient.listMySponsorProposals('pending');
    } catch {
      return null;
    }
  });
  const [answering, setAnswering] = useState<{ proposal: SponsorProposal; answer: Answer } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // While the list is read again the previous one stays, so the block doesn't blink.
  const list = requests.data ?? requests.stale ?? [];
  const finished = (result: SponsorProposal, answer: Answer) => {
    setAnswering(null);
    setDone(answer === 'accept'
      ? `You are now the sponsor of ${result.organization_name}. Its consumption counts against your plan.`
      : `You declined to sponsor ${result.organization_name}.`);
    requests.reload();
    announceChange();
  };

  if (requests.status === 'loading' && !requests.stale) {
    return <div aria-busy="true"><span className="sr-only">Reading your sponsor requests</span><Skeleton variant="tile" /></div>;
  }
  if (requests.data === null) {
    return <Notice tone="warning" action={<Action variant="secondary" size="sm" onClick={requests.reload}>Try again</Action>}>Your sponsor requests couldn’t be loaded right now.</Notice>;
  }
  if (list.length === 0 && !done) return null;

  return (
    <section className="notif-sponsor" aria-labelledby="notif-sponsor-title">
      <header>
        <h2 id="notif-sponsor-title">Sponsor requests for you</h2>
        <p>Someone asks you to be the billing sponsor of an organization. Nothing changes unless you accept.</p>
      </header>
      {done && <Notice tone="success">{done}</Notice>}
      <ul className="notif-sponsor-list" aria-label="Sponsor requests for you">
        {list.map((proposal) => (
          <li key={proposal.id}>
            <div className="notif-sponsor-main">
              <strong>{proposal.organization_name}</strong>
              <span>
                {proposerName(proposal)} asks you to sponsor it and everything under it.
                {' '}<span className="acct-muted">Sent {formatDate(proposal.created_at) ?? '—'} · {expiryText(proposal)}</span>
              </span>
            </div>
            <div className="notif-sponsor-actions">
              <Action variant="primary" size="sm" aria-label={`Accept sponsoring ${proposal.organization_name}`} onClick={() => setAnswering({ proposal, answer: 'accept' })}>Accept</Action>
              <Action variant="secondary" size="sm" aria-label={`Decline sponsoring ${proposal.organization_name}`} onClick={() => setAnswering({ proposal, answer: 'decline' })}>Decline</Action>
            </div>
          </li>
        ))}
      </ul>
      {answering && (
        <AnswerDialog
          proposal={answering.proposal}
          answer={answering.answer}
          plan={user?.plan}
          onClose={() => { setAnswering(null); requests.reload(); }}
          onDone={(result) => finished(result, answering.answer)}
        />
      )}
    </section>
  );
}
