import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { CircleCheck, CircleAlert, FileArchive, Upload, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  bimApi,
  type BimDiagnostic,
  type BimRefusal,
  type BimValidateResponse,
} from '../../api/bim';
import { HttpError } from '../../api/client';
import { BindingSpaceBadge } from '../../components/BindingSpaceBadge/BindingSpaceBadge';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { OrganizationPicker } from '../../components/ui/OrganizationPicker';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { candidateMatrix } from '../../entities/binding/candidateMatrix';
import { workflowGraph, type TaskOverlay } from '../../entities/binding/workflowGraph';
import { problemEditorPath } from '../../routes/paths/problems';
import type { ProblemFacts } from '../../shared/api/types';
import { fromBimAll, type PackageTexts } from '../../shared/diagnostics/bim';
import { counts, type Located } from '../../shared/diagnostics/located';
import { BIM_PACKAGE_LIMITS, BimPackageError, unzipPackage } from '../../utils/bimZip';
import { formatBytes } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { CandidateMatrix } from '../../widgets/candidate-matrix/CandidateMatrix';
import { ProblemsPanel } from '../../widgets/problems-panel/ProblemsPanel';
import { RulesAndObjectives } from '../../widgets/rules-and-objectives/RulesAndObjectives';
import { WorkflowGraph } from '../../widgets/workflow-graph/WorkflowGraph';
import './PublicPages.css';

interface Selected {
  name: string;
  bytes: Uint8Array;
  /** The official example it came from, which a signed-in account can open in the problem editor of an organization. */
  example: string | null;
}

type Run =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; outcome: BimValidateResponse | BimRefusal; texts: PackageTexts }
  | {
      status: 'failed';
      kind: 'too-large' | 'rate-limit' | 'unreadable' | 'unsupported' | 'unavailable';
      message: string;
    };

const MiB = 1024 * 1024;
const LIMIT_CHIPS = [
  `≤ ${BIM_PACKAGE_LIMITS.compressedBytes / MiB} MiB compressed`,
  `≤ ${BIM_PACKAGE_LIMITS.expandedBytes / MiB} MiB expanded`,
  `≤ ${BIM_PACKAGE_LIMITS.entries} entries`,
];

function fileLabel(bytes: number): string {
  return formatBytes(bytes) ?? `${bytes} bytes`;
}

/**
 * The gateway's findings placed in the files that were sent: errors of a refusal (or its message, when it itemises none), and the
 * warnings beside a valid package.
 */
function findingsOf(outcome: BimValidateResponse | BimRefusal, texts: PackageTexts): Located[] {
  // The analysis types its diagnostics as open objects; they are the compiler's findings.
  if (outcome.valid)
    return fromBimAll((outcome.diagnostics ?? []) as BimDiagnostic[], texts, 'warning');
  if (outcome.diagnostics.length) return fromBimAll(outcome.diagnostics, texts, 'error');
  return [
    { code: outcome.code, message: outcome.message, severity: 'error', where: { kind: 'package' } },
  ];
}

/** A valid package as the gateway compiled it: what it holds, its workflow, the candidates of each task, and its rules. */
function PackageStructure({
  facts,
  response,
}: {
  facts: ProblemFacts;
  response: BimValidateResponse;
}) {
  const graph = useMemo(() => workflowGraph(facts.workflow), [facts]);
  const matrix = useMemo(() => candidateMatrix(facts), [facts]);
  const overlay = useMemo(
    () =>
      Object.fromEntries(
        facts.tasks.map((task): [string, TaskOverlay] => [
          task.id,
          { local: task.kind === 'local' },
        ])
      ),
    [facts]
  );
  const { analysis } = response;
  return (
    <div className="workbench-structure">
      <section className="workbench-section" aria-labelledby="workbench-holds">
        <h2 id="workbench-holds">What the package holds</h2>
        <ul className="workbench-counts">
          <li>
            <b>{analysis.tasks}</b>
            <span>tasks</span>
          </li>
          <li>
            <b>{analysis.candidates}</b>
            <span>candidates</span>
          </li>
          <li>
            <b>{analysis.constraints}</b>
            <span>rules</span>
          </li>
          <li>
            <b>{analysis.placement ? 'Yes' : 'None'}</b>
            <span>placement</span>
          </li>
        </ul>
        {analysis.bindingSpace && (
          <div className="workbench-space">
            <span>Possible combinations</span>
            <BindingSpaceBadge cardinality={analysis.bindingSpace} />
          </div>
        )}
      </section>
      <section className="workbench-section" aria-labelledby="workbench-workflow">
        <h2 id="workbench-workflow">Workflow</h2>
        <WorkflowGraph graph={graph} overlay={overlay} label="Workflow of the package" />
      </section>
      <section className="workbench-section" aria-labelledby="workbench-candidates">
        <h2 id="workbench-candidates">Candidates</h2>
        <CandidateMatrix matrix={matrix} mode="view" label="Candidates of each task" />
      </section>
      <RulesAndObjectives facts={facts} subject="package" />
    </div>
  );
}

export function WorkbenchPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const requestedExample = params.get('template');
  const examples = useResource('workbench-templates', () => bimApi.templates());
  const { copy, status: copyStatus } = useCopy();
  const input = useRef<HTMLInputElement>(null);
  const runId = useRef(0);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [run, setRun] = useState<Run>(
    requestedExample ? { status: 'loading' } : { status: 'idle' }
  );
  const [dragging, setDragging] = useState(false);
  const [exampleError, setExampleError] = useState<string | null>(null);

  const validate = async (target: Selected) => {
    const id = ++runId.current;
    setRun({ status: 'loading' });
    const failed = (kind: Extract<Run, { status: 'failed' }>['kind'], message: string) => {
      if (id === runId.current) setRun({ status: 'failed', kind, message });
    };
    if (target.bytes.byteLength > BIM_PACKAGE_LIMITS.compressedBytes) {
      failed(
        'too-large',
        `${fileLabel(target.bytes.byteLength)} is over the ${BIM_PACKAGE_LIMITS.compressedBytes / MiB} MiB limit.`
      );
      return;
    }
    // The files are read only to place the gateway's findings in them; what the package means is the gateway's answer.
    let texts: PackageTexts;
    try {
      texts = await unzipPackage(
        target.bytes.buffer.slice(
          target.bytes.byteOffset,
          target.bytes.byteOffset + target.bytes.byteLength
        ) as ArrayBuffer
      );
    } catch (error) {
      failed(
        'unreadable',
        error instanceof BimPackageError
          ? error.message
          : 'The file could not be read as a ZIP archive.'
      );
      return;
    }
    try {
      const outcome = await bimApi.validate(target.bytes, {
        include: ['facts'],
        acceptRefusal: true,
      });
      if (id !== runId.current) return;
      setRun({ status: 'done', outcome, texts });
    } catch (error) {
      if (error instanceof HttpError && error.status === 413)
        failed('too-large', 'The gateway refused the package as too large.');
      else if (error instanceof HttpError && error.status === 429)
        failed(
          'rate-limit',
          error.retryAfter
            ? `Try again in ${error.retryAfter} s.`
            : 'Wait a few seconds and try again.'
        );
      else if (error instanceof HttpError && error.status === 415)
        failed('unsupported', 'The gateway only reads .bim.zip packages.');
      else
        failed(
          'unavailable',
          error instanceof HttpError ? `HTTP ${error.status}` : 'the gateway can’t be reached'
        );
    }
  };

  const loadExample = async (path: string) => {
    setExampleError(null);
    try {
      const buffer = await bimApi.template(path);
      const target: Selected = {
        name: `${path.split('/').at(-1) ?? 'example'}.bim.zip`,
        bytes: new Uint8Array(buffer),
        example: path,
      };
      setSelected(target);
      await validate(target);
    } catch (error) {
      setRun({ status: 'idle' });
      setExampleError(
        error instanceof HttpError && error.status === 422
          ? 'This template package is corrupt (422). Other templates are unaffected.'
          : error instanceof Error
            ? error.message
            : 'The template could not be loaded.'
      );
    }
  };

  useEffect(() => {
    if (requestedExample) void loadExample(requestedExample);
    // The address names the example once; choosing others afterwards is the person's action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedExample]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    const target: Selected = {
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      example: null,
    };
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
  const findings = useMemo(
    () => (run.status === 'done' ? findingsOf(run.outcome, run.texts) : []),
    [run]
  );
  const refusal = outcome && !outcome.valid ? outcome : null;
  const errorCount = refusal ? Math.max(counts(findings).error, 1) : 0;
  const suggested = (examples.data ?? [])
    .filter(path => path !== 'demo/05_single_obj_various')
    .slice(0, 3);

  return (
    <div className="workbench-page">
      <div className="workbench-head">
        <div>
          <h1>Workbench</h1>
          <p>
            Validate a BIM package without an account. You get the problems the gateway finds, each
            placed in its file, and, once it validates, its digests, workflow and candidates.
            Nothing is executed.
          </p>
        </div>
        <div className="workbench-limits" aria-label="Package limits">
          {LIMIT_CHIPS.map(chip => (
            <span key={chip}>{chip}</span>
          ))}
        </div>
      </div>

      <div className="workbench-layout">
        <section aria-label="Package" className="workbench-input">
          <div
            className={`workbench-drop${dragging ? ' is-dragging' : ''}${selected ? ' has-file' : ''}`}
            onDragOver={event => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <Upload aria-hidden="true" />
            <strong>Drop a .bim.zip here</strong>
            <span>or choose a file from your computer</span>
            <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
              Choose file
            </Button>
            <input
              ref={input}
              type="file"
              accept=".zip,.bim.zip,application/zip,application/vnd.bim+zip"
              className="sr-only"
              tabIndex={-1}
              aria-label="Package file"
              onChange={event => void choose(event.target.files?.[0])}
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
                <button type="button" aria-label="Remove file" onClick={clear}>
                  <X aria-hidden="true" />
                </button>
              </div>
              <Button
                size="lg"
                onClick={() => void validate(selected)}
                disabled={run.status === 'loading'}
              >
                {run.status === 'loading' ? 'Validating…' : 'Validate package'}
              </Button>
            </>
          )}

          <div className="workbench-card">
            <span className="workbench-kicker">Try a package</span>
            {exampleError && <Notice tone="error">{exampleError}</Notice>}
            {examples.status === 'loading' && <small>Reading the templates…</small>}
            {suggested.map(path => (
              <button
                key={path}
                type="button"
                className="workbench-try"
                onClick={() => {
                  setRun({ status: 'loading' });
                  void loadExample(path);
                }}
              >
                <strong>{path}</strong>
                <small>Template package</small>
              </button>
            ))}
            {examples.status === 'ready' && suggested.length === 0 && (
              <small>This deployment ships no template packages.</small>
            )}
          </div>

          <div className="workbench-card is-account">
            {user ? (
              <>
                <strong>Signed in as {user.username}</strong>
                <span>
                  Edit a package in the problem editor of one of your organizations, save it as a
                  problem version, then run it.
                </span>
                <div className="workbench-account-actions">
                  <OrganizationPicker
                    variant="primary"
                    label="Open in the problem editor"
                    destination={org =>
                      problemEditorPath(org, { template: selected?.example ?? undefined })
                    }
                  />
                </div>
                {selected && !selected.example && (
                  <small>
                    An uploaded file isn’t carried across: upload it on the organization’s problem
                    list, then open its version in the editor.
                  </small>
                )}
              </>
            ) : (
              <>
                <strong>Want to run an engine on it?</strong>
                <span>
                  Validation is free. Running engines and saving packages as problems needs an
                  account.
                </span>
                <div className="workbench-account-actions">
                  <Link className="workbench-login" to="/login">
                    Log in to run
                  </Link>
                  <Link className="workbench-secondary" to="/register">
                    Create account
                  </Link>
                </div>
              </>
            )}
          </div>
        </section>

        <section
          aria-label="Result"
          aria-live="polite"
          aria-busy={run.status === 'loading'}
          className="workbench-result"
        >
          {run.status === 'idle' && (
            <div className="workbench-idle">
              <strong>{selected ? 'Ready to validate' : 'No package yet'}</strong>
              <span>
                {selected
                  ? `${selected.name} is selected. Press Validate package to get the verdict.`
                  : 'Choose a .bim.zip or try an official package. The verdict appears here.'}
              </span>
            </div>
          )}

          {run.status === 'loading' && (
            <div className="workbench-loading">
              <strong>Uploading and compiling…</strong>
              <div className="workbench-progress" aria-hidden="true">
                <div />
              </div>
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
              title={
                {
                  'too-large': 'The package is too large (413 · payload_too_large)',
                  'rate-limit': 'Too many validations right now (429).',
                  unreadable: 'This file can’t be read as a BIM package',
                  unsupported: 'The gateway can’t read this file type (415)',
                  unavailable: `Validation is unavailable right now (${run.message})`,
                }[run.kind]
              }
              action={
                selected && run.kind !== 'unreadable' && run.kind !== 'too-large' ? (
                  <Button size="sm" variant="secondary" onClick={() => void validate(selected)}>
                    {run.kind === 'rate-limit' ? 'Try again' : 'Retry'}
                  </Button>
                ) : undefined
              }
            >
              {run.kind === 'too-large' &&
                `Public validation accepts up to ${BIM_PACKAGE_LIMITS.compressedBytes / MiB} MiB compressed, ${BIM_PACKAGE_LIMITS.expandedBytes / MiB} MiB expanded and ${BIM_PACKAGE_LIMITS.entries} entries. Remove unused files, or sign in: your plan sets its own payload ceiling. ${run.message}`}
              {run.kind === 'rate-limit' &&
                `The gateway limits public validation. ${run.message} Your file is still selected.`}
              {run.kind === 'unreadable' && run.message}
              {run.kind === 'unsupported' && run.message}
              {run.kind === 'unavailable' && 'Your file is still selected; nothing was changed.'}
            </Notice>
          )}

          {outcome && (
            <>
              <div className={`workbench-verdict ${outcome.valid ? 'is-valid' : 'is-invalid'}`}>
                {outcome.valid ? (
                  <CircleCheck aria-hidden="true" />
                ) : (
                  <CircleAlert aria-hidden="true" />
                )}
                <div>
                  <strong>
                    {outcome.valid
                      ? 'Valid package'
                      : `Not valid · ${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`}
                  </strong>
                  <span>
                    {outcome.valid
                      ? [
                          selected?.name,
                          `${outcome.analysis.tasks} ${outcome.analysis.tasks === 1 ? 'task' : 'tasks'}`,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : `${refusal?.status} ${refusal?.code}. ${refusal?.diagnostics.length ? 'Each problem names the file and the place to fix. Nothing is drawn until the package validates.' : refusal?.message}`}
                  </span>
                </div>
              </div>

              {outcome.valid && (
                <div className="workbench-digests">
                  {(
                    [
                      ['Instance digest', outcome.instanceDigest],
                      ['Package digest', outcome.packageDigest],
                      ['IR digest', outcome.irDigest],
                    ] as const
                  ).map(([label, digest]) => (
                    <div key={label}>
                      <span>
                        <small>{label}</small>
                        <code>computed</code>
                      </span>
                      <button
                        type="button"
                        aria-label={`Copy ${label.toLowerCase()}`}
                        onClick={() => void copy(digest, label)}
                      >
                        {copyStatus(label) === 'copied' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {outcome.valid &&
                (outcome.facts ? (
                  <PackageStructure facts={outcome.facts} response={outcome} />
                ) : (
                  <p className="workbench-muted">The gateway sent no structure for this package.</p>
                ))}
              {(!outcome.valid || findings.length > 0) && (
                <ProblemsPanel diagnostics={findings} groups />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
