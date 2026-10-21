import { useEffect, useRef, useState, type DragEvent } from 'react';
import { CircleCheck, CircleAlert, FileArchive, Upload, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiClient, HttpError, type PackageValidationOutcome } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { ProjectPicker } from '../../components/ui/ProjectPicker';
import { LanguageNav } from '../../components/ui/SectionNav';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { BIM_PACKAGE_LIMITS, BimPackageError } from '../../utils/bimZip';
import { formatBytes } from '../../utils/format';
import { shortDigest } from '../../utils/digest';
import { useResource } from '../../utils/useResource';
import { groupDiagnostics, readDiagnostics } from '../Workbench/diagnostics';
import { readPackageModel, type PackageModel } from '../Workbench/packageModel';
import { DiagnosticsPanel, StructurePanel } from '../Workbench/WorkbenchResult';
import './PublicPages.css';

interface Selected {
  name: string;
  bytes: Uint8Array;
  /** The official example it came from, which a signed-in account can carry into a project. */
  example: string | null;
}

type Run =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; outcome: PackageValidationOutcome; model: PackageModel | null }
  | { status: 'failed'; kind: 'too-large' | 'rate-limit' | 'unreadable' | 'unsupported' | 'unavailable'; message: string };

const MiB = 1024 * 1024;
const LIMIT_CHIPS = [
  `≤ ${BIM_PACKAGE_LIMITS.compressedBytes / MiB} MiB compressed`,
  `≤ ${BIM_PACKAGE_LIMITS.expandedBytes / MiB} MiB expanded`,
  `≤ ${BIM_PACKAGE_LIMITS.entries} entries`,
];

function fileLabel(bytes: number): string {
  return formatBytes(bytes) ?? `${bytes} bytes`;
}

export function WorkbenchPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const requestedExample = params.get('example');
  const examples = useResource('workbench-examples', () => apiClient.getBimExamples());
  const { copy, status: copyStatus } = useCopy();
  const input = useRef<HTMLInputElement>(null);
  const runId = useRef(0);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [run, setRun] = useState<Run>(requestedExample ? { status: 'loading' } : { status: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState('structure');
  const [focusTarget, setFocusTarget] = useState<{ id: string; n: number } | null>(null);
  const [exampleError, setExampleError] = useState<string | null>(null);

  const validate = async (target: Selected) => {
    const id = ++runId.current;
    setRun({ status: 'loading' });
    setTab('structure');
    const failed = (kind: Extract<Run, { status: 'failed' }>['kind'], message: string) => {
      if (id === runId.current) setRun({ status: 'failed', kind, message });
    };
    if (target.bytes.byteLength > BIM_PACKAGE_LIMITS.compressedBytes) {
      failed('too-large', `${fileLabel(target.bytes.byteLength)} is over the ${BIM_PACKAGE_LIMITS.compressedBytes / MiB} MiB limit.`);
      return;
    }
    let model: PackageModel | null = null;
    try {
      model = await readPackageModel(target.bytes.buffer.slice(target.bytes.byteOffset, target.bytes.byteOffset + target.bytes.byteLength) as ArrayBuffer);
    } catch (error) {
      failed('unreadable', error instanceof BimPackageError ? error.message : 'The file could not be read as a ZIP archive.');
      return;
    }
    try {
      const outcome = await apiClient.validatePackage(target.bytes);
      if (id !== runId.current) return;
      setRun({ status: 'done', outcome, model });
      if (!outcome.valid) setTab('diagnostics');
    } catch (error) {
      if (error instanceof HttpError && error.status === 413) failed('too-large', 'The gateway refused the package as too large.');
      else if (error instanceof HttpError && error.status === 429) failed('rate-limit', error.retryAfter ? `Try again in ${error.retryAfter} s.` : 'Wait a few seconds and try again.');
      else if (error instanceof HttpError && error.status === 415) failed('unsupported', 'The gateway only reads .bim.zip packages.');
      else failed('unavailable', error instanceof HttpError ? `HTTP ${error.status}` : 'the gateway can’t be reached');
    }
  };

  const loadExample = async (path: string) => {
    setExampleError(null);
    try {
      const buffer = await apiClient.getBimExamplePackage(path);
      const target: Selected = { name: `${path.split('/').at(-1) ?? 'example'}.bim.zip`, bytes: new Uint8Array(buffer), example: path };
      setSelected(target);
      await validate(target);
    } catch (error) {
      setRun({ status: 'idle' });
      setExampleError(error instanceof HttpError && error.status === 422
        ? 'This example package is corrupt (422 · invalid_example). Other examples are unaffected.'
        : error instanceof Error ? error.message : 'The example could not be loaded.');
    }
  };

  useEffect(() => {
    if (requestedExample) void loadExample(requestedExample);
    // The address names the example once; choosing others afterwards is the person's action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedExample]);

  useEffect(() => {
    if (!focusTarget) return;
    const element = document.getElementById(focusTarget.id);
    // Older engines and test environments have no scrollIntoView; focusing the target is what matters.
    element?.scrollIntoView?.({ block: 'center' });
    element?.focus({ preventScroll: true });
  }, [focusTarget]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    const target: Selected = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), example: null };
    setSelected(target);
    setRun({ status: 'idle' });
    setExampleError(null);
  };

  const clear = () => {
    runId.current += 1;
    setSelected(null);
    setRun({ status: 'idle' });
    if (input.current) input.current.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  };

  const outcome = run.status === 'done' ? run.outcome : null;
  const model = run.status === 'done' ? run.model : null;
  const files = model?.files ?? [];
  const diagnostics = outcome
    ? readDiagnostics(outcome.valid ? outcome.result.diagnostics : outcome.refusal.diagnostics, files)
    : [];
  const groups = groupDiagnostics(diagnostics);
  const refusal = outcome && !outcome.valid ? outcome.refusal : null;
  const errorCount = refusal ? Math.max(diagnostics.length, 1) : 0;
  const suggested = (examples.data ?? []).filter((path) => path !== 'demo/05_single_obj_various').slice(0, 3);

  const showFile = (path: string) => {
    setTab('structure');
    setFocusTarget((current) => ({ id: `wb-file-${path}`, n: (current?.n ?? 0) + 1 }));
  };
  const showProblems = (path: string) => {
    setTab('diagnostics');
    setFocusTarget((current) => ({ id: `wb-problems-${path || 'package'}`, n: (current?.n ?? 0) + 1 }));
  };

  return (
    <div className="workbench-page">
      <div className="workbench-head">
        <div>
          <LanguageNav current="workbench" />
          <h1>Workbench</h1>
          <p>Validate a BIM package without an account. You get localized diagnostics, digests and the structure of the composition. Nothing is executed.</p>
        </div>
        <div className="workbench-limits" aria-label="Package limits">
          {LIMIT_CHIPS.map((chip) => <span key={chip}>{chip}</span>)}
        </div>
      </div>

      <div className="workbench-layout">
        <section aria-label="Package" className="workbench-input">
          <div
            className={`workbench-drop${dragging ? ' is-dragging' : ''}${selected ? ' has-file' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <Upload aria-hidden="true" />
            <strong>Drop a .bim.zip here</strong>
            <span>or choose a file from your computer</span>
            <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>Choose file</Button>
            <input
              ref={input}
              type="file"
              accept=".zip,.bim.zip,application/zip,application/vnd.bim+zip"
              className="sr-only"
              tabIndex={-1}
              aria-label="Package file"
              onChange={(event) => void choose(event.target.files?.[0])}
            />
          </div>

          {selected && (
            <>
              <div className="workbench-file">
                <FileArchive aria-hidden="true" />
                <span>
                  <code>{selected.name}</code>
                  <small>{fileLabel(selected.bytes.byteLength)} · .bim.zip</small>
                </span>
                <button type="button" aria-label="Remove file" onClick={clear}><X aria-hidden="true" /></button>
              </div>
              <Button size="lg" onClick={() => void validate(selected)} disabled={run.status === 'loading'}>
                {run.status === 'loading' ? 'Validating…' : 'Validate package'}
              </Button>
            </>
          )}

          <div className="workbench-card">
            <span className="workbench-kicker">Try a package</span>
            {exampleError && <Notice tone="error">{exampleError}</Notice>}
            {examples.status === 'loading' && <small>Reading the official examples…</small>}
            {suggested.map((path) => (
              <button key={path} type="button" className="workbench-try" onClick={() => { setRun({ status: 'loading' }); void loadExample(path); }}>
                <strong>{path}</strong>
                <small>Official example package</small>
              </button>
            ))}
            {examples.status === 'ready' && suggested.length === 0 && <small>This deployment ships no example packages.</small>}
            <Link to="/examples">Browse official examples</Link>
          </div>

          <div className="workbench-card is-account">
            {user ? (
              <>
                <strong>Signed in as {user.username}</strong>
                <span>Save this package as a case revision in one of your projects, then run it with an exact engine.</span>
                <div className="workbench-account-actions">
                  <ProjectPicker variant="primary" label="Save to a project" destination={(org, project) => `/app/${org}/${project}/workbench${selected?.example ? `?example=${encodeURIComponent(selected.example)}` : ''}`} />
                  <ProjectPicker label="Run" destination={(org, project) => `/app/${org}/${project}/jobs/new`} />
                </div>
                {selected && !selected.example && <small>An uploaded file isn’t carried across: add it again in the project workbench.</small>}
              </>
            ) : (
              <>
                <strong>Want to run an engine on it?</strong>
                <span>Validation is free. Running engines and saving packages as cases needs an account.</span>
                <div className="workbench-account-actions">
                  <Link className="workbench-login" to="/login">Log in to run</Link>
                  <Link className="workbench-secondary" to="/register">Create account</Link>
                </div>
              </>
            )}
          </div>
        </section>

        <section aria-label="Result" aria-live="polite" aria-busy={run.status === 'loading'} className="workbench-result">
          {run.status === 'idle' && (
            <div className="workbench-idle">
              <strong>{selected ? 'Ready to validate' : 'No package yet'}</strong>
              <span>
                {selected
                  ? `${selected.name} is selected. Press Validate package to get the verdict, digests and structure.`
                  : 'Choose a .bim.zip or try an official package. The verdict, digests and structure appear here.'}
              </span>
            </div>
          )}

          {run.status === 'loading' && (
            <div className="workbench-loading">
              <strong>Uploading and compiling…</strong>
              <div className="workbench-progress" aria-hidden="true"><div /></div>
              <ol>
                <li>Unpacking entries and checking size limits</li>
                <li>Validating resources against the Profile and dialects</li>
                <li>Compiling the BindingProblem IR</li>
              </ol>
            </div>
          )}

          {run.status === 'failed' && (
            <Notice
              tone={run.kind === 'rate-limit' ? 'warning' : 'error'}
              title={{
                'too-large': 'The package is too large (413 · payload_too_large)',
                'rate-limit': 'Too many validations right now (429).',
                unreadable: 'This file can’t be read as a BIM package',
                unsupported: 'The gateway can’t read this file type (415)',
                unavailable: `Validation is unavailable right now (${run.message})`,
              }[run.kind]}
              action={selected && run.kind !== 'unreadable' && run.kind !== 'too-large'
                ? <Button size="sm" variant="secondary" onClick={() => void validate(selected)}>{run.kind === 'rate-limit' ? 'Try again' : 'Retry'}</Button>
                : undefined}
            >
              {run.kind === 'too-large' && `Public validation accepts up to ${BIM_PACKAGE_LIMITS.compressedBytes / MiB} MiB compressed, ${BIM_PACKAGE_LIMITS.expandedBytes / MiB} MiB expanded and ${BIM_PACKAGE_LIMITS.entries} entries. Remove unused files, or sign in: your plan sets its own payload ceiling. ${run.message}`}
              {run.kind === 'rate-limit' && `The gateway limits public validation. ${run.message} Your file is still selected.`}
              {run.kind === 'unreadable' && run.message}
              {run.kind === 'unsupported' && run.message}
              {run.kind === 'unavailable' && 'Your file is still selected; nothing was changed.'}
            </Notice>
          )}

          {outcome && (
            <>
              <div className={`workbench-verdict ${outcome.valid ? 'is-valid' : 'is-invalid'}`}>
                {outcome.valid ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
                <div>
                  <strong>{outcome.valid ? 'Valid package' : `Not valid · ${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`}</strong>
                  <span>
                    {outcome.valid
                      ? [selected?.name, model?.profile ? `profile ${model.profile}` : null, model && model.tasks.length ? `${model.tasks.length} tasks` : null].filter(Boolean).join(' · ')
                      : `${refusal?.status} ${refusal?.code}. ${diagnostics.length > 0 ? 'Each diagnostic points at the resource and location to fix.' : refusal?.message}`}
                  </span>
                </div>
              </div>

              {outcome.valid && (
                <div className="workbench-digests">
                  {([
                    ['Instance digest', outcome.result.instanceDigest],
                    ['Package digest', outcome.result.packageDigest],
                    ['IR digest', outcome.result.irDigest],
                  ] as const).map(([label, digest]) => (
                    <div key={label}>
                      <span>
                        <small>{label}</small>
                        <code title={digest}>{shortDigest(digest)}</code>
                      </span>
                      <button type="button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copy(digest, label)}>
                        {copyStatus(label) === 'copied' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <TabBar
                prefix="workbench"
                ariaLabel="Result views"
                value={tab}
                onChange={setTab}
                items={[
                  { id: 'structure', label: 'Structure' },
                  { id: 'diagnostics', label: `Diagnostics (${outcome.valid ? diagnostics.length : errorCount})` },
                ]}
              />
              <TabPanel prefix="workbench" active={tab}>
                {tab === 'structure' && (
                  model
                    ? (
                      <StructurePanel
                        model={model}
                        valid={outcome.valid}
                        fileDigests={outcome.valid ? outcome.result.fileDigests : {}}
                        problemsByFile={Object.fromEntries(groups.filter((group) => group.file).map((group) => [group.file, group.items.length]))}
                        onShowProblems={showProblems}
                      />
                    )
                    : <p className="workbench-muted">The structure could not be read from this package.</p>
                )}
                {tab === 'diagnostics' && (
                  <DiagnosticsPanel
                    valid={outcome.valid}
                    groups={groups}
                    summary={refusal && diagnostics.length === 0 ? refusal.message : null}
                    onShowFile={showFile}
                    copy={(value, key) => void copy(value, key)}
                    copied={(key) => copyStatus(key) === 'copied'}
                  />
                )}
              </TabPanel>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
