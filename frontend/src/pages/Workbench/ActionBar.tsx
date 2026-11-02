import { Link } from 'react-router-dom';
import type { BindingCase, CaseRevision } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { problemPath, problemsPath } from '../../routes/paths/problems';
import { refusalText, snapshotHref } from './workbenchModel';
import type { Workbench } from './useWorkbench';

interface ActionBarProps {
  wb: Workbench;
  /** MEMBER or above in the project's organization. */
  canSave: boolean;
  cases: BindingCase[];
  target: string;
  onTarget: (slug: string) => void;
  /** The versions the target problem has now, to tell a new version from one that already existed. */
  revisions: readonly CaseRevision[];
  /** The versions of the target problem have been read, so a saved version can be told from one that already existed. */
  revisionsReady: boolean;
  root: string;
}

/** What a valid package can become: a snapshot, a run, or a version of a problem. Shown only once the gateway has accepted the package. */
// [impl->req~frontend-nav-vocabulary-text~1]
export function ActionBar({ wb, canSave, cases, target, onTarget, revisions, revisionsReady, root }: ActionBarProps) {
  if (wb.status !== 'valid') return null;
  const targetCase = cases.find((item) => item.slug === target);
  // A version saved just now is sealed from the snapshot but is not in the list read when the problem was chosen.
  const known = wb.saved && !wb.saved.existing ? [wb.saved.revision, ...revisions] : revisions;
  return (
    <div className="wb-dock">
      {canSave && cases.length === 0 && (
        <p className="wb-muted">This project has no problems yet. <Link to={problemsPath(root)} viewTransition>Start one in Problems</Link> to save this package as its first version.</p>
      )}
      {wb.snapshot && !wb.snapshotIssue && (
        <Notice tone="success" action={<Link to={snapshotHref(root, target, known, wb.snapshot.id)} viewTransition>Open snapshot</Link>}>Snapshot created. It is private to your account and never changes.</Notice>
      )}
      {wb.snapshotIssue && <Notice tone="error" title="The snapshot couldn’t be made">{refusalText(wb.snapshotIssue, 'no snapshot was made')}</Notice>}
      {wb.saved && (
        <Notice
          tone="success"
          action={(
            <Link to={wb.saved.existing ? problemPath(root, target, 'versions') : problemPath(root, target, undefined, { version: wb.saved.revision.revision })} viewTransition>
              {wb.saved.existing ? 'See versions' : 'Open it'}
            </Link>
          )}
        >
          {wb.saved.existing
            ? `Same content as version ${wb.saved.revision.revision}, so no new version was needed.`
            : `Version ${wb.saved.revision.revision} of ${targetCase?.name ?? target} saved and sealed.`}
        </Notice>
      )}
      {wb.saveIssue && <Notice tone="error" title="The version wasn’t saved">{wb.saveIssue}</Notice>}
      <section className="wb-bar" aria-label="Package actions">
        <span className="wb-bar-note">
          {canSave
            ? 'Valid packages can be snapshotted, run or saved as a version of a problem.'
            : 'You can snapshot and run with your own account; saving into this project needs MEMBER.'}
        </span>
        <Action variant="secondary" busy={wb.snapshotBusy} onClick={() => void wb.compile()}>{wb.snapshot ? 'Snapshot created' : 'Create snapshot'}</Action>
        <Action variant="secondary" onClick={() => document.getElementById('wb-run')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })}>Run…</Action>
        {canSave && cases.length > 0 && (
          <label className="wb-bar-case">
            <span className="sr-only">Save into problem</span>
            <select aria-label="Save into problem" value={target} onChange={(event) => onTarget(event.target.value)}>
              <option value="">Save into a problem…</option>
              {cases.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
            </select>
          </label>
        )}
        <Action
          variant="primary"
          busy={wb.saveBusy}
          disabled={!canSave || !target || !revisionsReady}
          title={!canSave ? 'Saving into this project needs MEMBER' : !target ? 'Choose the problem to save into' : !revisionsReady ? 'Reading the problem’s versions…' : undefined}
          onClick={() => void wb.saveRevision(target, revisions)}
        >
          Save as problem version
        </Action>
      </section>
    </div>
  );
}
