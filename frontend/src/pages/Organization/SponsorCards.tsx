import { useId, type ReactNode } from 'react';
import type { SponsorProposal, SponsorProposalStatus } from '../../api/auth';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { DataTable } from '../../components/ui/DataTable';
import { formatDate } from '../../utils/format';
import { closedText, expiryText, PROPOSAL_STATUS, proposedName, proposerName, reasonText } from './sponsorModel';
import './Organization.css';

/** The state of a request as a small label. */
export function ProposalChip({ status }: { status: SponsorProposalStatus }) {
  return <Chip tone={PROPOSAL_STATUS[status].tone}>{PROPOSAL_STATUS[status].label}</Chip>;
}

interface RequestCardProps {
  proposal: SponsorProposal;
  /** The heading: “Sponsor request sent” for the one just made. */
  title?: string;
  /** Show Cancel, and how it is going. */
  cancel?: { busy: boolean; onCancel: () => void };
  /** Show Replace request: the caller sent the pending request and is naming somebody else (or again). */
  replace?: { busy: boolean; onReplace: () => void };
  children?: ReactNode;
}

/** The request that is waiting for an answer: who has to accept, until when, and what can still be done with it. */
export function SponsorRequestCard({ proposal, title = 'Sponsor request sent', cancel, replace, children }: RequestCardProps) {
  const id = useId();
  const person = proposedName(proposal);
  return (
    <section className="org-card org-request" aria-labelledby={id}>
      <div className="org-request-head">
        <h3 id={id}>{title}</h3>
        <ProposalChip status={proposal.status} />
      </div>
      <p className="org-muted">
        <strong>{person}</strong> has to accept before anything changes. Until then {proposal.organization_name} and everything under it stay with the current sponsor.
      </p>
      <dl className="org-request-facts" aria-label="Sponsor request">
        <div><dt>Person</dt><dd>{person}</dd></div>
        <div><dt>Status</dt><dd>{PROPOSAL_STATUS[proposal.status].label.toLowerCase()}</dd></div>
        <div><dt>{proposal.status === 'pending' ? 'Expires' : 'Closed'}</dt><dd>{proposal.status === 'pending' ? formatDate(proposal.expires_at) ?? '—' : closedText(proposal)}</dd></div>
        <div><dt>Sent by</dt><dd>{proposerName(proposal)}</dd></div>
      </dl>
      {children}
      {(cancel || replace) && (
        <div className="org-request-actions">
          {cancel && <Action variant="secondary" size="sm" onClick={cancel.onCancel} busy={cancel.busy}>Cancel</Action>}
          {replace && <Action variant="primary" size="sm" onClick={replace.onReplace} busy={replace.busy}>Replace request</Action>}
        </div>
      )}
    </section>
  );
}

/** Every request made for an organization, the open one first. */
export function SponsorProposalList({ proposals }: { proposals: readonly SponsorProposal[] }) {
  if (proposals.length === 0) return <p className="org-muted">No sponsor requests yet.</p>;
  return (
    <DataTable label="Request history" minWidth={560}>
      <thead>
        <tr>
          <th scope="col">Person</th>
          <th scope="col">Status</th>
          <th scope="col">Sent by</th>
          <th scope="col">Sent</th>
          <th scope="col">Outcome</th>
        </tr>
      </thead>
      <tbody>
        {proposals.map((proposal) => (
          <tr key={proposal.id}>
            <th scope="row">{proposedName(proposal)}</th>
            <td><ProposalChip status={proposal.status} /></td>
            <td>{proposerName(proposal)}</td>
            <td className="org-muted-cell">{formatDate(proposal.created_at) ?? '—'}</td>
            <td className="org-muted-cell">
              {proposal.status === 'pending' ? expiryText(proposal) : closedText(proposal)}
              {reasonText(proposal.decision_reason) && <small className="org-request-reason"> · {reasonText(proposal.decision_reason)}</small>}
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}
