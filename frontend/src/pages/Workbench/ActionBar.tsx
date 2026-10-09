import { Link } from 'react-router-dom';
import type { BindingCase, CaseRevision } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { refusalText } from './workbenchModel';
import type { Workbench } from './useWorkbench';

interface ActionBarProps {
  wb: Workbench;
  /** MEMBER or above in the project's organization. */
  canSave: boolean;
  cases: BindingCase[];
  target: string;
  onTarget: (slug: string) => void;
  /** The revisions the target case has now, to tell a new revision from one that already existed. */
  revisions: readonly CaseRevision[];
  /** The revisions of the target case have been read, so a saved revision can be told from one that already existed. */
  revisionsReady: boolean;
  root: string;
}

/** What a valid package can become: a snapshot, a run, or a revision of a case. Shown only once the gateway has accepted the package. */
export function ActionBar({ wb, canSave, cases, target, onTarget, revisions, revisionsReady, root }: ActionBarProps) {
  if (wb.status !== 'valid') return null;
  const targetCase = cases.find((item) => item.slug === target);
  const base = `${root}/cases/${target}`;
  return (
    <div className="wb-dock">
      {canSave && cases.length === 0 && (
        <p className="wb-muted">This project has no cases yet. <Link to={`${root}/cases`} viewTransition>Start one in Cases</Link> to save this package as its first revision.</p>
      )}
      {wb.snapshot && !wb.snapshotIssue && (
        <Notice tone="success" action={<Link to={`${root}/snapshots/${wb.snapshot.id}`} viewTransition>Open snapshot</Link>}>Snapshot created. It is private to your account and never changes.</Notice>
      )}
      {wb.snapshotIssue && <Notice tone="error" title="The snapshot couldn’t be made">{refusalText(wb.snapshotIssue, 'no snapshot was made')}</Notice>}
      {wb.saved && (
        <Notice
          tone="success"
          action={<Link to={wb.saved.existing ? base : `${base}/revisions/${wb.saved.revision.revision}`} viewTransition>{wb.saved.existing ? 'See revisions' : 'Open it'}</Link>}
        >
          {wb.saved.existing
            ? `Same content as revision ${wb.saved.revision.revision}, so no new revision was needed.`
            : `Revision ${wb.saved.revision.revision} of ${targetCase?.name ?? target} saved and sealed.`}
        </Notice>
      )}
      {wb.saveIssue && <Notice tone="error" title="The revision wasn’t saved">{wb.saveIssue}</Notice>}
      <section className="wb-bar" aria-label="Package actions">
        <span className="wb-bar-note">
          {canSave
            ? 'Valid packages can be snapshotted, run or saved as a revision of a case.'
            : 'You can snapshot and run with your own account; saving into this project needs MEMBER.'}
        </span>
        <Action variant="secondary" busy={wb.snapshotBusy} onClick={() => void wb.compile()}>{wb.snapshot ? 'Snapshot created' : 'Create snapshot'}</Action>
        <Action variant="secondary" onClick={() => document.getElementById('wb-run')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })}>Run…</Action>
        {canSave && cases.length > 0 && (
          <label className="wb-bar-case">
            <span className="sr-only">Save into case</span>
            <select aria-label="Save into case" value={target} onChange={(event) => onTarget(event.target.value)}>
              <option value="">Save into a case…</option>
              {cases.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
            </select>
          </label>
        )}
        <Action
          variant="primary"
          busy={wb.saveBusy}
          disabled={!canSave || !target || !revisionsReady}
          title={!canSave ? 'Saving into this project needs MEMBER' : !target ? 'Choose the case to save into' : !revisionsReady ? 'Reading the case’s revisions…' : undefined}
          onClick={() => void wb.saveRevision(target, revisions)}
        >
          Save as case revision
        </Action>
      </section>
    </div>
  );
}
