import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, FileText, KeyRound } from 'lucide-react';
import { BindingSpaceBadge } from '../../components/BindingSpaceBadge/BindingSpaceBadge';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useCopy } from '../../components/ui/useCopy';
import { shortDigest } from '../../utils/digest';
import { readBindingProblem } from '../Cases/bindingModel';
import { FlowDrawing, Power } from '../Cases/parts';
import { resourcePathForDiagnostic, type Diagnostic, type ResourceEntry } from './bimDocuments';
import { LIMIT_KINDS, engineRows, goalTerms, packageFileList, refusalMarker, refusalText, type Refusal } from './workbenchModel';
import type { Workbench } from './useWorkbench';

type ResultView = 'analysis' | 'engines' | 'files';

export interface PlanFacts {
  name: string | null;
  /** The plan's ceiling for the size of a problem, as a power of ten. */
  ceiling: number | null;
  /** The plan's ceiling for one request, as people read it (`128 MiB`). */
  maxLabel: string | null;
}

interface CheckResultProps {
  wb: Workbench;
  plan: PlanFacts;
  pricingHref: string;
}

/** The fix a diagnostic suggests, when the gateway wrote one. */
function fixOf(item: Diagnostic): string | null {
  const fields = item as Record<string, unknown>;
  for (const key of ['fix', 'hint', 'suggestion']) {
    const value = fields[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

const NO_DIAGNOSTIC_TEXT = 'The gateway sent no message for this diagnostic.';

// [impl->req~frontend-rendering-check-result-diagnostic-text~1]
/** The words of a diagnostic: its message, else its detail, when they are text; never a dump of the item. */
function textOf(item: Diagnostic): string {
  const fields = item as Record<string, unknown>;
  if (typeof fields.message === 'string' && fields.message) return fields.message;
  if (typeof fields.detail === 'string' && fields.detail) return fields.detail;
  return NO_DIAGNOSTIC_TEXT;
}

function DiagnosticList({ diagnostics, resources, onOpen }: { diagnostics: Diagnostic[]; resources: ResourceEntry[]; onOpen: (item: Diagnostic) => void }) {
  return (
    <ul className="wb-diags" aria-label="Diagnostics">
      {diagnostics.map((item, index) => {
        const file = resourcePathForDiagnostic(resources, item) ?? item.resource ?? item.path ?? 'Package';
        const where = item.bpmnElement || item.element ? `BPMN element ${item.bpmnElement || item.element}` : item.pointer || item.jsonPointer || null;
        const fix = fixOf(item);
        return (
          <li className="wb-diag" key={`${item.code ?? 'diagnostic'}-${index}`}>
            <div className="wb-diag-head">
              <Chip mono>{file}</Chip>
              {where && <><span aria-hidden="true">›</span><span className="wb-diag-where">{where}</span></>}
            </div>
            <div className="wb-diag-body">
              <button type="button" className="wb-diag-open" onClick={() => onOpen(item)}>
                <code>{item.code || 'diagnostic'}</code> {textOf(item)}
              </button>
              {fix && <span className="wb-diag-fix"><b>Fix:</b> {fix}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Compiling({ origin }: { origin: Workbench['origin'] }) {
  return (
    <div className="wb-compiling" role="status">
      <span className="wb-compiling-title"><span className="wb-spinner" aria-hidden="true" />{origin === 'package' ? 'Compiling the package…' : 'Checking the package you brought in…'}</span>
      <div className="wb-progress" aria-hidden="true"><i /></div>
      <span className="wb-muted">Reading files → checking each resource → measuring the problem.</span>
    </div>
  );
}

function AuthGate({ refusal }: { refusal: Refusal }) {
  return (
    <div className="wb-gate" role="alert">
      <KeyRound aria-hidden="true" />
      <span>
        {refusal.kind === 'session'
          ? <>Checking a package needs a session{refusalMarker(refusal)}. <Link to="/login" viewTransition>Log in again</Link>; your package is kept in this browser.</>
          : <>This credential doesn’t include “validate instances”{refusalMarker(refusal)}, so the package can’t be checked with it. Use a session, or a key that includes it.</>}
      </span>
    </div>
  );
}

function TooBig({ refusal, plan, pricingHref, onReduce }: { refusal: Refusal; plan: PlanFacts; pricingHref: string; onReduce: () => void }) {
  const ceiling = refusal.limit ?? plan.ceiling;
  const scale = Math.max(30, Math.ceil((ceiling ?? 0) * 1.2));
  return (
    <div className="wb-too-big" role="alert">
      <strong>Too big for your plan{refusalMarker({ status: refusal.status, code: refusal.code ?? 'instance complexity' })}</strong>
      <div className="wb-limit-bar" aria-hidden="true">
        <i />
        {ceiling !== null && <b style={{ left: `${Math.min(100, Math.round((ceiling / scale) * 100))}%` }} />}
      </div>
      <span>
        {ceiling !== null ? <>Your {plan.name ? `${plan.name} ` : ''}plan allows up to <Power log10={ceiling} /> combinations. </> : 'Your plan limits how many combinations a problem may have. '}
        {refusal.size
          ? <>This package has {refusal.size}.</>
          : 'The server doesn’t report the measured size in this answer, so we can’t show how far over it is.'}
      </span>
      <span className="wb-links">
        <button type="button" className="wb-link" onClick={onReduce}>Reduce candidates</button>
        <Link to={pricingHref} viewTransition>Compare plans</Link>
      </span>
    </div>
  );
}

function ValidSummary({ wb }: { wb: Workbench }) {
  const { copy, status } = useCopy();
  const name = wb.root?.metadata?.name || 'Package';
  const profile = wb.root?.spec?.profile;
  const chips = wb.digests ? ([
    ['instance', 'Instance', wb.digests.instance], ['package', 'Package', wb.digests.package], ['compiled', 'Compiled', wb.digests.compiled],
  ] as const).filter(([, , value]) => value) : [];
  return (
    <section className="wb-valid" aria-label="Validation result">
      <span className="wb-valid-mark" aria-hidden="true"><CheckCircle2 /></span>
      <div className="wb-valid-main">
        <h2>Valid package</h2>
        <p>{name}{profile ? ` · ${profile}` : ''}</p>
      </div>
      {chips.length > 0 && (
        <div className="wb-digests">
          {chips.map(([key, label, value]) => (
            <button type="button" key={key} className="wb-digest" title={value} aria-label={`Copy the ${label.toLowerCase()} fingerprint`} onClick={() => void copy(value, key)}>
              {label} · <code>{status(key) === 'copied' ? 'copied' : status(key) === 'failed' ? 'copy failed' : shortDigest(value)}</code>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function AnalysisView({ wb }: { wb: Workbench }) {
  const model = useMemo(() => (wb.compiledIr ? readBindingProblem(wb.compiledIr.document) : null), [wb.compiledIr]);
  const analysis = wb.analysisData;
  const terms = goalTerms(wb.files, wb.resources);
  const counts = [
    { value: analysis ? String(analysis.tasks) : '—', label: 'tasks' },
    { value: analysis ? String(analysis.candidates) : '—', label: 'candidates' },
    { value: analysis ? String(analysis.constraints) : '—', label: 'rules' },
    { value: String(terms), label: 'goal terms' },
    { value: analysis ? (analysis.placement ? 'Yes' : 'None') : '—', label: 'placement' },
  ];
  return (
    <div className="wb-view">
      <ul className="wb-counts" aria-label="What the package holds">
        {counts.map((count) => <li key={count.label}><b>{count.value}</b><span>{count.label}</span></li>)}
      </ul>
      {analysis?.bindingSpace && (
        <div className="wb-space"><BindingSpaceBadge cardinality={analysis.bindingSpace} variant="card" /></div>
      )}
      <section className="wb-card" aria-labelledby="wb-flow-title">
        <div className="wb-flow-head">
          <h3 id="wb-flow-title" className="wb-eyebrow">Workflow</h3>
          {wb.root?.spec?.profile && <span className="wb-muted">· profile {wb.root.spec.profile}</span>}
        </div>
        {wb.compiledIr ? (
          <FlowDrawing flow={model?.flow ?? null} caption={model?.log10 != null ? <span>Possible combinations ≈ <Power log10={model.log10} /></span> : undefined} />
        ) : (
          <div className="wb-flow-ask">
            <p className="wb-muted">The drawing comes from the compiled package. Drawing it saves a private snapshot of the package, the same one the actions below use.</p>
            <Action variant="secondary" busy={wb.irLoading} onClick={() => void wb.compile()}>Draw the workflow</Action>
          </div>
        )}
        {wb.irError && <Notice tone="warning">{wb.irError}</Notice>}
      </section>
    </div>
  );
}

function EnginesView({ wb }: { wb: Workbench }) {
  const rows = engineRows(wb.allModes);
  if (rows.length === 0) {
    return <p className="wb-empty" role="note">The analysis listed no engine modes for this package, so nothing can run it yet.</p>;
  }
  return (
    <div className="wb-table-wrap">
      <table className="wb-table">
        <caption className="sr-only">Engine modes and whether they can run this package</caption>
        <thead>
          <tr><th scope="col">Engine</th><th scope="col">Mode</th><th scope="col">Can run this?</th><th scope="col">Why</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                <span>{row.name}</span>
                {row.registered && <Chip tone="accent">Registered</Chip>}
              </th>
              <td><code>{row.mode}</code></td>
              <td><Chip tone={row.runnable ? 'success' : 'warning'}>{row.runnable ? 'Yes' : 'No'}</Chip></td>
              <td>{row.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FilesView({ wb }: { wb: Workbench }) {
  const list = packageFileList(wb.files, wb.resources);
  return (
    <>
      <ul className="wb-files" aria-label="Files in the package">
        {list.map((file) => (
          <li key={file.path}>
            <span className="wb-file-tile" aria-hidden="true">{file.tile}</span>
            <span className="wb-file-name"><strong>{file.path}</strong><small>{file.what}</small></span>
            <button
              type="button"
              className="wb-link"
              onClick={() => {
                wb.selectResource(file.path, file.kind);
                document.getElementById('wb-editor')?.scrollIntoView?.({ block: 'start' });
              }}
            >
              <FileText aria-hidden="true" />Edit {file.path}
            </button>
          </li>
        ))}
      </ul>
      <p className="wb-muted">This package lives in your browser until you snapshot it or save it as a case revision.</p>
    </>
  );
}

/** What checking the package answered: still compiling, nothing yet, a refusal in its own words, or the valid package and what is in it. */
export function CheckResult({ wb, plan, pricingHref }: CheckResultProps) {
  const [view, setView] = useState<ResultView>('analysis');
  const { refusal, status } = wb;
  const reduceCandidates = () => {
    const catalog = wb.resources.find((resource) => resource.kind === 'CandidateCatalog' && resource.path);
    if (catalog?.path) wb.selectResource(catalog.path, catalog.kind);
    document.getElementById('wb-editor')?.scrollIntoView?.({ block: 'start' });
  };

  if (status === 'validating') return <Compiling origin={wb.origin} />;

  if (status === 'idle' && wb.diagnostics.length === 0) {
    return (
      <p className="wb-empty" role="note">
        Nothing validated yet. Pick a case revision, drop a file or start from an example, or validate the package below as it is.
      </p>
    );
  }

  if (status === 'failed' && refusal) {
    const problems = wb.diagnostics;
    return (
      <div className="wb-check-failed">
        {(refusal.kind === 'session' || refusal.kind === 'key') && <AuthGate refusal={refusal} />}
        {refusal.kind === 'too-big' && <TooBig refusal={refusal} plan={plan} pricingHref={pricingHref} onReduce={reduceCandidates} />}
        {LIMIT_KINDS.includes(refusal.kind) && (
          // No "compare plans" here: the plan doesn't state the limit, this deployment caps it whatever the plan, or the plan can't be applied.
          <Notice
            tone="error"
            title={`${refusal.title ?? 'A limit refused the package'}${refusalMarker(refusal)}`}
            action={refusal.kind === 'technical'
              ? <Action variant="secondary" size="sm" onClick={reduceCandidates}>Reduce candidates</Action>
              : refusal.kind === 'unmeasured' ? <Action variant="secondary" size="sm" onClick={() => void wb.validate()}>Check again</Action> : undefined}
          >
            {refusal.message}
          </Notice>
        )}
        {refusal.kind === 'too-large' && (
          <div className="wb-alert" role="alert">
            {plan.maxLabel
              ? `The file is larger than your plan allows per request (${plan.maxLabel}) · ${refusal.status ?? 413}.`
              : `The package is larger than your plan allows per request${refusalMarker(refusal)}.`}
          </div>
        )}
        {refusal.kind === 'invalid' && (
          <div className="wb-alert" role="alert">
            Not valid · {problems.length === 1 ? '1 problem' : `${problems.length} problems`}{refusalMarker(refusal)}
            {wb.origin !== 'package' && <span className="wb-alert-note"> Your current package was kept.</span>}
          </div>
        )}
        {(refusal.kind === 'unsupported' || refusal.kind === 'busy' || refusal.kind === 'unavailable' || refusal.kind === 'other') && (
          <Notice
            tone="error"
            title="The package couldn’t be checked"
            action={<Action variant="secondary" size="sm" onClick={() => void wb.validate()}>Check again</Action>}
          >
            {refusalText(refusal, 'nothing was checked')}
          </Notice>
        )}
        {problems.length > 0 && <DiagnosticList diagnostics={problems} resources={wb.resources} onOpen={wb.openDiagnostic} />}
      </div>
    );
  }

  if (status === 'valid') {
    const runnable = wb.compatibleModes.length;
    return (
      <>
        <ValidSummary wb={wb} />
        {wb.diagnostics.length > 0 && <DiagnosticList diagnostics={wb.diagnostics} resources={wb.resources} onOpen={wb.openDiagnostic} />}
        <TabBar
          items={[
            { id: 'analysis', label: 'What’s inside' },
            { id: 'engines', label: 'Engines that can run it', count: runnable },
            { id: 'files', label: 'Files', count: Object.keys(wb.files).length },
          ]}
          value={view}
          onChange={(id) => setView(id as ResultView)}
          ariaLabel="Result view"
          prefix="wb-view"
        />
        <TabPanel prefix="wb-view" active={view}>
          {view === 'analysis' && <AnalysisView wb={wb} />}
          {view === 'engines' && <EnginesView wb={wb} />}
          {view === 'files' && <FilesView wb={wb} />}
        </TabPanel>
      </>
    );
  }

  // Edits that left problems of their own (a diagram that wasn't applied) while nothing is being checked.
  return wb.diagnostics.length > 0 ? <DiagnosticList diagnostics={wb.diagnostics} resources={wb.resources} onOpen={wb.openDiagnostic} /> : null;
}
