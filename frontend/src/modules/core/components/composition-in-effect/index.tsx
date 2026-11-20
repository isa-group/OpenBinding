// The version in effect in a composition environment, as the gateway's environment view says it: the version and its
// adoption, its value status, the candidate bound to each task with the upstream plan it was read from (from the version's
// upstream view, stored data only), and the offering version the pinned evaluation read. SPHERE has no environments; the
// rows follow the renderer's binding section. It takes data and links only, and imports no domain module, so the
// `operations` mode and any screen can draw it. The slot `badge` is where F6's upstream badge goes; it draws nothing in F4.

import { formatDistanceToNow, parseISO } from 'date-fns';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { EnvironmentInEffect, UpstreamView } from '../../api/types';
import { offeringReadText } from '../../utils/composition/upstream';
import { ValueBadge } from '../value-badge/ValueBadge';

interface Props {
  inEffect: EnvironmentInEffect;
  /** The upstream view of the version in effect, when the screen read it: the plan each candidate comes from. */
  upstream?: UpstreamView | null;
  /** Where the version in effect opens. */
  versionHref?: string | null;
  /** F6's upstream badge, beside the heading; nothing in F4. */
  badge?: ReactNode;
}

const OUTCOME_TEXT: Partial<
  Record<NonNullable<EnvironmentInEffect['evaluation']>['outcome'], string>
> = {
  binding_invalid: 'The evaluation it was adopted on found its binding not valid for its problem.',
  semantics_changed:
    'The installed toolchain reads its problem differently from the evaluation it was adopted on.',
};

/** "plan PROFESSIONAL of brevo, version 2026-10", from the upstream entry of a task. */
function planText(upstream: UpstreamView | null | undefined, task: string): string | null {
  const entry = upstream?.entries.find(item => item.task === task);
  if (!entry?.plan) return null;
  const snapshot = entry.snapshot;
  const of = snapshot ? ` of ${snapshot.title}` : '';
  const version = snapshot?.versionName ? `, version ${snapshot.versionName}` : '';
  return `plan ${entry.plan.name}${of}${version}`;
}

export function CompositionInEffect({
  inEffect,
  upstream = null,
  versionHref = null,
  badge,
}: Props) {
  const evaluation = inEffect.evaluation;
  const offering = offeringReadText(inEffect.offering);
  const by = inEffect.adoptedBy ? ` by ${inEffect.adoptedBy.displayName}` : '';
  const tasks = Object.entries(inEffect.binding);
  return (
    <section aria-label="In effect" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-tp-ink">
          In effect:{' '}
          {versionHref ? (
            <Link to={versionHref} className="font-mono hover:text-tp-accent hover:underline">
              {inEffect.version.label}
            </Link>
          ) : (
            <span className="font-mono">{inEffect.version.label}</span>
          )}
        </h3>
        {evaluation && <ValueBadge status={evaluation.valuesStatus} />}
        <span className="rounded bg-tp-surface px-1.5 py-0.5 text-[11px] text-tp-steel">
          Adoption #{inEffect.adoption}
        </span>
        {badge}
      </div>
      <p className="text-xs text-tp-steel">
        {`Adopted ${formatDistanceToNow(parseISO(inEffect.adoptedAt))} ago${by}.`}
        {inEffect.note ? ` “${inEffect.note}”` : ''}
      </p>
      {evaluation && OUTCOME_TEXT[evaluation.outcome] && (
        <p className="text-xs text-tp-error-strong">{OUTCOME_TEXT[evaluation.outcome]}</p>
      )}
      {tasks.length > 0 && (
        <ul
          aria-label="Binding in effect"
          className="flex flex-col divide-y divide-tp-hairline rounded-lg border border-tp-hairline"
        >
          {tasks.map(([task, bound]) => {
            const plan = planText(upstream, task);
            return (
              <li
                key={task}
                className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3"
              >
                <span className="w-32 shrink-0 text-xs font-medium text-tp-steel">{task}</span>
                <span className="min-w-0 font-mono text-xs break-all text-tp-ink">
                  {bound.candidate}
                </span>
                {plan && <span className="text-[11px] text-tp-steel">{plan}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {offering && <p className="text-xs text-tp-steel">{offering}</p>}
    </section>
  );
}
