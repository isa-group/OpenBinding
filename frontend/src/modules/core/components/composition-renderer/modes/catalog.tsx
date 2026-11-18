import type { ReactNode } from 'react';
import type { UpstreamSnapshot } from '../../../api/types';
import type { RendererUpstream } from '../../../utils/composition/upstream';
import { SOURCE_WORD } from '../../value-badge/originText';
import { Link } from 'react-router-dom';
import { Notice } from '../../notice';
import type { Evidence, Provenance } from '../../../utils/composition/document';
import { kindLabel } from '../../../utils/composition/kinds';
import { formatValue } from '../../../utils/composition/values';
import type { CompositionViewModel, TaskModel } from '../../../utils/composition/viewModel';
import ProblemsPanel from '../../problems-panel';
import { ValueBadge } from '../../value-badge/ValueBadge';
import type { RendererLinks } from '../CompositionRenderer';
import type { Section } from '../presets';
import { RendererSection } from '../RendererSection';
import { OfferingDrawn } from './OfferingDrawn';

/**
 * The catalog mode: what a composition is and what it says, read top to bottom. Every value is the gateway's, placed as it came;
 * the words about trust come from the value status and the evaluation's outcome, never from a comparison made here.
 */

interface CatalogModeProps extends RendererLinks {
  model: CompositionViewModel;
  sections: readonly Section[];
  upstream?: RendererUpstream | null;
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

/**
 * Where a candidate came from, by names: the pricing as SPHERE titles it and the version's name when OpenBinding holds the
 * snapshot, else the reference as the document writes it (owner/name and plan; a version id is not a name).
 */
function provenanceText(from: Provenance, snapshot: UpstreamSnapshot | null): string {
  const where = from.registry ? `on the SPHERE registry ${from.registry}` : 'on SPHERE';
  const parts = [
    snapshot ? `${snapshot.title} ${where}` : `${from.sphere} ${where}`,
    `plan ${from.plan}`,
    snapshot?.versionName ? `version ${snapshot.versionName}` : 'a pinned version',
  ];
  if (from.addons?.length) parts.push(`add-ons ${from.addons.join(', ')}`);
  return parts.join(', ');
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

function TaskLine({ task, snapshot }: { task: TaskModel; snapshot: UpstreamSnapshot | null }) {
  return (
    <li>
      <code>{task.id}</code>
      <span className="cr-arrow text-tp-steel" aria-hidden="true">
        →
      </span>
      {task.local ? (
        <span>In-house</span>
      ) : task.candidate ? (
        <code>{task.candidate}</code>
      ) : (
        <span className="cr-muted m-0 text-[13px] text-tp-steel">Not bound</span>
      )}
      {task.from && (
        <span className="cr-from basis-full text-xs [overflow-wrap:anywhere] text-tp-steel">
          From {provenanceText(task.from, snapshot)}
        </span>
      )}
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
  upstream = null,
}: CatalogModeProps) {
  const shows = (section: Section) => sections.includes(section);
  const { identity, version, status } = model;
  const member = model.reader === 'member';

  const identityBlock = shows('identity') && (
    <header className="cr-identity flex flex-col gap-1 [&_h2]:m-0 [&_h2]:text-xl [&_h2]:[overflow-wrap:anywhere] [&_p]:m-0 [&_p]:[overflow-wrap:anywhere] [&_p]:text-tp-slate">
      <h2>{identity.name}</h2>
      <span className="cr-kind text-[13px] text-tp-steel">
        {kindLabel(identity.kind)} · {identity.orgName}
      </span>
      {identity.description && <p>{identity.description}</p>}
    </header>
  );

  if (!version) {
    return (
      <>
        {identityBlock}
        <p className="cr-muted m-0 text-[13px] text-tp-steel">
          No version yet: nothing has been sealed for this composition.
        </p>
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
          <div className="cr-status flex flex-wrap items-center gap-x-3 gap-y-2 [&_p]:m-0 [&_p]:text-sm [&_p]:text-tp-slate">
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
            <p className="cr-muted m-0 text-[13px] text-tp-steel">
              This version records no values.
            </p>
          ) : (
            <dl className="cr-values m-0 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 [&_dd]:m-0 [&_dd]:text-base [&_dd]:font-semibold [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-tp-ink [&_dt]:text-xs [&_dt]:[overflow-wrap:anywhere] [&_dt]:text-tp-steel [&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div]:gap-0.5 [&>div]:rounded-xl [&>div]:border [&>div]:border-tp-hairline [&>div]:bg-tp-canvas [&>div]:p-3">
              {model.values.map(value => {
                const sources = upstream?.view.values[value.name];
                return (
                  <div key={value.name}>
                    <dt>{value.name}</dt>
                    <dd>{formatValue(value.value, value.unit)}</dd>
                    {sources && sources.sources.length > 0 && (
                      <ul
                        className="cr-sources m-0 flex list-none flex-wrap gap-1 p-0"
                        aria-label={`Where ${value.name} comes from`}
                      >
                        {sources.sources.map(kind => (
                          <li
                            key={kind}
                            className={`rounded-full border px-1.5 text-[11px] font-semibold text-tp-ink-tint ${kind === 'manual' ? 'border-dashed border-tp-hairline-strong' : 'border-tp-primary'}`}
                          >
                            {SOURCE_WORD[kind]}
                          </li>
                        ))}
                        {sources.manualOnly && (
                          <li className="rounded-full border border-tp-severity-warning-border bg-tp-severity-warning-bg px-1.5 text-[11px] font-semibold text-tp-warning-text">
                            Set by hand only
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                );
              })}
            </dl>
          )}
        </RendererSection>
      )}

      {shows('binding') && (
        <RendererSection title="Binding">
          {model.tasks.length === 0 ? (
            <p className="cr-muted m-0 text-[13px] text-tp-steel">This version binds no task.</p>
          ) : (
            <ul
              className="cr-binding m-0 flex list-none flex-col gap-1.5 p-0 [&_code]:font-mono [&_code]:text-[13px] [&_code]:[overflow-wrap:anywhere] [&>li]:flex [&>li]:min-w-0 [&>li]:flex-wrap [&>li]:items-baseline [&>li]:gap-x-2 [&>li]:gap-y-1 [&>li]:border-b [&>li]:border-tp-hairline-soft [&>li]:py-1.5"
              aria-label="Task bindings"
            >
              {model.tasks.map(task => (
                <TaskLine
                  key={task.id}
                  task={task}
                  snapshot={
                    upstream?.view.entries.find(entry => entry.task === task.id)?.snapshot ?? null
                  }
                />
              ))}
            </ul>
          )}
        </RendererSection>
      )}

      {shows('offering') && (
        <RendererSection title="Offering">
          {!model.offering ? (
            <p className="cr-muted m-0 text-[13px] text-tp-steel">
              This version names no pricing of its own.
            </p>
          ) : (
            <p className="cr-muted m-0 text-[13px] text-tp-steel">
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
          {model.offering && <OfferingDrawn upstream={upstream} />}
        </RendererSection>
      )}

      {shows('evidence') && (evidence.length > 0 || derivation) && (
        <RendererSection title="Evidence">
          <ul className="cr-lines m-0 flex list-none flex-col gap-1 p-0 text-sm text-tp-slate [&_code]:font-mono [&_code]:text-[13px] [&_li]:[overflow-wrap:anywhere]">
            {evidence.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
            {derivation && <li>{derivation}</li>}
          </ul>
        </RendererSection>
      )}

      {shows('problem') && status.problemRef && (
        <RendererSection title="Problem">
          <p className="cr-muted m-0 text-[13px] text-tp-steel">
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
