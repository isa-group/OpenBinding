import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Notice } from '../../../modules/core/components/notice';
import type { Evidence, Provenance } from '../../../entities/composition/document';
import { kindLabel } from '../../../entities/composition/kinds';
import { formatValue } from '../../../entities/composition/values';
import type { CompositionViewModel, TaskModel } from '../../../entities/composition/viewModel';
import { ProblemsPanel } from '../../problems-panel/ProblemsPanel';
import { ValueBadge } from '../../value-badge/ValueBadge';
import type { RendererLinks } from '../CompositionRenderer';
import type { Section } from '../presets';
import { RendererSection } from '../RendererSection';

/**
 * The catalog mode: what a composition is and what it says, read top to bottom. Every value is the gateway's, placed as it came;
 * the words about trust come from the value status and the evaluation's outcome, never from a comparison made here.
 */

interface CatalogModeProps extends RendererLinks {
  model: CompositionViewModel;
  sections: readonly Section[];
}

const shortId = (id: string) => id.slice(0, 8);

/** What the value status means, in a sentence, for the outcome of the current evaluation. */
function statusText(model: CompositionViewModel): string {
  const { values, outcome } = model.status;
  if (values === 'verified')
    return 'The toolchain evaluated this binding against the problem it links and computed these values.';
  if (values === 'declared') return 'The author wrote these values; no problem checks them.';
  if (outcome === 'binding_invalid')
    return 'The toolchain found this binding invalid for the problem it links, so these values are not verified.';
  if (outcome === 'semantics_changed')
    return 'The problem this version links has changed meaning since the values were computed: they are not verified.';
  return 'No evaluation by the installed toolchain has verified these values yet.';
}

/** Where a candidate came from: the SPHERE pricing, its plan, the pinned version and the add-ons, as the document writes them. */
function provenanceText(from: Provenance): string {
  const parts = [
    `${from.sphere}${from.registry ? ` on ${from.registry}` : ''}`,
    `plan ${from.plan}`,
    `version ${from.version}`,
  ];
  if (from.addons?.length) parts.push(`add-ons ${from.addons.join(', ')}`);
  return parts.join(' · ');
}

function RunLink({ run, runHref }: { run: string; runHref: RendererLinks['runHref'] }) {
  const href = runHref?.(run) ?? null;
  return href ? (
    <Link to={href}>run {shortId(run)}</Link>
  ) : (
    <>
      run <code>{shortId(run)}</code>
    </>
  );
}

function TaskLine({ task }: { task: TaskModel }) {
  return (
    <li>
      <code>{task.id}</code>
      <span className="cr-arrow" aria-hidden="true">
        →
      </span>
      {task.local ? (
        <span>In-house</span>
      ) : task.candidate ? (
        <code>{task.candidate}</code>
      ) : (
        <span className="cr-muted">Not bound</span>
      )}
      {task.from && <span className="cr-from">From {provenanceText(task.from)}</span>}
    </li>
  );
}

function evidenceLines(evidence: Evidence | null, runHref: RendererLinks['runHref']): ReactNode[] {
  if (!evidence) return [];
  const lines: ReactNode[] = [];
  if (evidence.evaluatedBy === 'gateway')
    lines.push(
      <>
        Evaluated by the gateway
        {evidence.toolchain ? (
          <>
            {' '}
            with <code>{evidence.toolchain}</code>
          </>
        ) : null}
        .
      </>
    );
  else if (evidence.evaluatedBy === 'declared') lines.push(<>Declared by the author.</>);
  else if (evidence.toolchain)
    lines.push(
      <>
        Toolchain <code>{evidence.toolchain}</code>.
      </>
    );
  if (evidence.run)
    lines.push(
      <>
        Values of <RunLink run={evidence.run} runHref={runHref} />
        {evidence.point !== undefined ? `, point ${evidence.point}` : ''}.
      </>
    );
  if (evidence.manual) lines.push(<>The binding was chosen by hand.</>);
  return lines;
}

function derivationLine(
  model: CompositionViewModel,
  runHref: RendererLinks['runHref']
): ReactNode | null {
  const derivation = model.version?.derivation;
  if (!derivation) return null;
  if (derivation.source === 'run' && derivation.run) {
    return (
      <>
        Derived from <RunLink run={derivation.run.id} runHref={runHref} />
        {derivation.point !== null ? `, point ${derivation.point}` : ''}.
      </>
    );
  }
  return <>Derived from a binding of problem version {derivation.revision.revision}.</>;
}

export function CatalogMode({
  model,
  sections,
  problemHref = null,
  runHref = null,
}: CatalogModeProps) {
  const shows = (section: Section) => sections.includes(section);
  const { identity, version, status } = model;
  const member = model.reader === 'member';

  const identityBlock = shows('identity') && (
    <header className="cr-identity">
      <h2>{identity.name}</h2>
      <span className="cr-kind">
        {kindLabel(identity.kind)} · {identity.orgName}
      </span>
      {identity.description && <p>{identity.description}</p>}
    </header>
  );

  if (!version) {
    return (
      <>
        {identityBlock}
        <p className="cr-muted">No version yet: nothing has been sealed for this composition.</p>
      </>
    );
  }

  const evidence = evidenceLines(model.evidence, runHref);
  const derivation = derivationLine(model, runHref);

  return (
    <>
      {identityBlock}

      {shows('status') && status.values && (
        <RendererSection title="Value status">
          <div className="cr-status">
            <ValueBadge status={status.values} />
            <p>{statusText(model)}</p>
          </div>
          {status.compilationDrift && (
            <Notice tone="warning" title="Evaluated on another compilation">
              These values were evaluated on a compilation of the problem other than the one this
              version links.
            </Notice>
          )}
        </RendererSection>
      )}

      {shows('values') && (
        <RendererSection title="Values">
          {model.values.length === 0 ? (
            <p className="cr-muted">This version records no values.</p>
          ) : (
            <dl className="cr-values">
              {model.values.map(value => (
                <div key={value.name}>
                  <dt>{value.name}</dt>
                  <dd>{formatValue(value.value, value.unit)}</dd>
                </div>
              ))}
            </dl>
          )}
        </RendererSection>
      )}

      {shows('binding') && (
        <RendererSection title="Binding">
          {model.tasks.length === 0 ? (
            <p className="cr-muted">This version binds no task.</p>
          ) : (
            <ul className="cr-binding" aria-label="Task bindings">
              {model.tasks.map(task => (
                <TaskLine key={task.id} task={task} />
              ))}
            </ul>
          )}
        </RendererSection>
      )}

      {shows('offering') && (
        <RendererSection title="Offering">
          {!model.offering ? (
            <p className="cr-muted">This version names no pricing of its own.</p>
          ) : (
            <p className="cr-muted">
              {model.offering.href ? (
                <a href={model.offering.href} rel="noreferrer" target="_blank">
                  {model.offering.label}
                </a>
              ) : (
                <code>{model.offering.label}</code>
              )}
              {model.offering.source !== 'url' && ' (SPHERE pricing)'}
            </p>
          )}
        </RendererSection>
      )}

      {shows('evidence') && (evidence.length > 0 || derivation) && (
        <RendererSection title="Evidence">
          <ul className="cr-lines">
            {evidence.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
            {derivation && <li>{derivation}</li>}
          </ul>
        </RendererSection>
      )}

      {shows('problem') && status.problemRef && (
        <RendererSection title="Problem">
          <p className="cr-muted">
            {problemHref && status.problemReadable ? (
              <Link to={problemHref}>
                <code>{status.problemRef}</code>
              </Link>
            ) : (
              <code>{status.problemRef}</code>
            )}
            {!member && ' — the problem itself is not shared.'}
          </p>
        </RendererSection>
      )}

      {shows('diagnostics') && member && (
        <ProblemsPanel diagnostics={model.diagnostics} title="Evaluation findings" />
      )}
    </>
  );
}
