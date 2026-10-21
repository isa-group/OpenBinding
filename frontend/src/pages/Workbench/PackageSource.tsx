import { useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileArchive, History, RotateCcw } from 'lucide-react';
import type { BindingCase, CaseRevision } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import type { Workbench } from './useWorkbench';

type SourceTab = 'case' | 'upload' | 'example';

const TABS = [
  { id: 'case', label: 'Case revision' },
  { id: 'upload', label: 'Upload file' },
  { id: 'example', label: 'Example' },
] as const;

interface CaseChoices {
  cases: BindingCase[];
  state: 'loading' | 'ready' | 'failed';
  revisions: CaseRevision[];
  revisionsState: 'idle' | 'loading' | 'ready' | 'failed';
  picked: string;
  onPickCase: (slug: string) => void;
  /** The revision the workspace was opened from (id or number), if any. */
  openedRevision: string | null;
  onPickRevision: (revision: CaseRevision) => void;
}

interface PackageSourceProps {
  wb: Workbench;
  choices: CaseChoices;
  requestedExample: boolean;
  /** The plan's request ceiling in bytes, when it is known, and how it reads. */
  maxBytes: number | null;
  maxLabel: string | null;
  planName: string | null;
  casesHref: string;
}

/** Where the package comes from: a revision of a case, a file from the computer, or one of the examples. */
export function PackageSource({ wb, choices, requestedExample, maxBytes, maxLabel, planName, casesHref }: PackageSourceProps) {
  const [tab, setTab] = useState<SourceTab>(requestedExample ? 'example' : 'case');
  const [dragging, setDragging] = useState(false);
  const validating = wb.status === 'validating';
  const opened = choices.revisions.find((revision) => revision.id === choices.openedRevision || String(revision.revision) === choices.openedRevision);
  const pickedCase = choices.cases.find((item) => item.slug === choices.picked);

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void wb.importFile(file, maxBytes);
  };

  return (
    <section className="wb-card" aria-labelledby="wb-package-title">
      <div className="wb-card-head">
        <h2 id="wb-package-title">Package</h2>
        <Action variant="primary" busy={validating} onClick={() => void wb.validate()}>Validate</Action>
      </div>
      <TabBar items={TABS} value={tab} onChange={(id) => setTab(id as SourceTab)} ariaLabel="Where the package comes from" prefix="wb-source" />
      <TabPanel prefix="wb-source" active={tab}>
        {tab === 'case' && (
          <div className="wb-source-body">
            {choices.state === 'failed' && <Notice tone="warning">The project’s cases couldn’t be listed. You can still upload a file or open an example.</Notice>}
            {choices.state === 'ready' && choices.cases.length === 0 && (
              <p className="wb-muted">This project has no cases yet. Start one in <Link to={casesHref} viewTransition>Cases</Link>, or upload a file.</p>
            )}
            <div className="wb-source-row">
              <label className="wb-field">
                <span>Case</span>
                <select value={choices.picked} disabled={choices.state !== 'ready' || choices.cases.length === 0} onChange={(event) => choices.onPickCase(event.target.value)}>
                  <option value="">{choices.state === 'loading' ? 'Loading cases…' : 'Choose a case…'}</option>
                  {choices.cases.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
                </select>
              </label>
              <label className="wb-field">
                <span>Revision</span>
                <select
                  value={opened?.id ?? ''}
                  disabled={!choices.picked || choices.revisionsState !== 'ready' || choices.revisions.length === 0}
                  onChange={(event) => {
                    const revision = choices.revisions.find((item) => item.id === event.target.value);
                    if (revision) choices.onPickRevision(revision);
                  }}
                >
                  <option value="">{choices.revisionsState === 'loading' ? 'Loading revisions…' : choices.picked && choices.revisionsState === 'ready' && choices.revisions.length === 0 ? 'No revisions yet' : 'Choose a revision…'}</option>
                  {choices.revisions.map((revision) => (
                    <option key={revision.id} value={revision.id}>{pickedCase?.name ?? choices.picked} · revision {revision.revision}</option>
                  ))}
                </select>
              </label>
              {opened && wb.hydrated && <Chip tone="accent">Loaded revision {opened.revision}</Chip>}
            </div>
            {choices.revisionsState === 'failed' && <Notice tone="warning">That case’s revisions couldn’t be listed.</Notice>}
          </div>
        )}
        {tab === 'upload' && (
          <div className="wb-source-body">
            <label
              className={`wb-drop${dragging ? ' is-dragging' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <FileArchive aria-hidden="true" />
              <strong>Drop a .bim.zip here</strong>
              <span className="wb-muted">{maxLabel ? `Up to ${maxLabel} on your plan${planName ? ` (${planName})` : ''}` : 'The gateway refuses packages larger than your plan allows'}</span>
              <span className="ui-action is-secondary is-md">
                <span>Import .bim.zip</span>
                <input
                  className="sr-only"
                  type="file"
                  aria-label="Import .bim.zip"
                  accept=".zip,.bim.zip,application/zip,application/vnd.bim+zip"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void wb.importFile(file, maxBytes);
                    event.currentTarget.value = '';
                  }}
                />
              </span>
            </label>
            <p className="wb-muted">The file replaces the package below only if the gateway accepts it; otherwise nothing changes.</p>
          </div>
        )}
        {tab === 'example' && (
          <div className="wb-source-body">
            <label className="wb-field">
              <span>Load backend example</span>
              <select
                value=""
                aria-label="Load backend example"
                onChange={(event) => { void wb.loadExample(event.target.value); }}
              >
                <option value="">Load example…</option>
                {wb.examples.map((path) => <option key={path} value={path}>{path}</option>)}
              </select>
            </label>
            <p className="wb-muted">Or pick a ready example in <Link to="/examples" viewTransition>Examples</Link> and choose “Open in workbench”.</p>
          </div>
        )}
      </TabPanel>
      {wb.migrationNotes.length > 0 && (
        <div className="wb-migration" role="status">
          <strong>This draft used an older vocabulary and was rewritten with the one of the schemas. Nothing was dropped.</strong>
          <ul>{wb.migrationNotes.map((note) => <li key={note}>{note}</li>)}</ul>
          <Action variant="ghost" size="sm" onClick={wb.dismissMigration}>Dismiss</Action>
        </div>
      )}
      <div className="wb-card-foot">
        <Action variant="ghost" size="sm" onClick={wb.undo} disabled={!wb.historyDepth}><History aria-hidden="true" />Undo edit</Action>
        <Action variant="ghost" size="sm" onClick={wb.reset}><RotateCcw aria-hidden="true" />Reset workspace</Action>
        <Action variant="ghost" size="sm" onClick={wb.exportPackage}><Download aria-hidden="true" />Export .bim.zip</Action>
        {wb.draftIssue && <span className="wb-draft-issue" role="status">{wb.draftIssue}</span>}
      </div>
    </section>
  );
}
