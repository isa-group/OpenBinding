// Adapted from SPHERE frontend/src/modules/orbit/components/plan-card.tsx (revision 73779a8a, blob fa103561),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the step list of the proposal card (index.tsx): SPHERE's `StepIcon` and `Collapsible` with accessible names
// and states; each step's base in words, a part an earlier step decides said as such, its error line, a done step's link,
// and for a step with a stored preview "Compare with the version in effect" and "Show the document" (both drawn by the
// caller's renderers, so the card renders no source itself).

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  MdCancel,
  MdCheckCircle,
  MdExpandMore,
  MdRadioButtonUnchecked,
  MdSkipNext,
} from 'react-icons/md';
import type { ProposalStepView } from '../../api/types';

/** What a step's link leads to: a label and an address. */
export interface StepLink {
  label: string;
  to: string;
}

interface StepCallbacks {
  /** Draws the gateway's diff of a step's stored document against the version in effect. */
  renderDiff?: (diff: Record<string, unknown>, step: ProposalStepView) => ReactNode;
  /** A step's base in words; the card's own words without it. */
  describeBase?: (step: ProposalStepView) => string | null;
  /** Where a done step's result opens. */
  resultLink?: (step: ProposalStepView) => StepLink | null;
  /** Draws a seal step's stored document (the platform's source view); without it the document is not offered. */
  renderDocument?: (document: string, step: ProposalStepView) => ReactNode;
}

function StepIcon({
  status,
  running = false,
}: {
  status: ProposalStepView['status'];
  running?: boolean;
}) {
  if (running)
    return (
      <span
        aria-label="Running"
        className="mt-[2px] h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-tp-primary border-t-transparent"
      />
    );
  switch (status) {
    case 'done':
      return (
        <MdCheckCircle
          size={15}
          aria-label="Done"
          className="mt-[1px] shrink-0 text-tp-severity-success"
        />
      );
    case 'failed':
      return (
        <MdCancel
          size={15}
          aria-label="Failed"
          className="mt-[1px] shrink-0 text-tp-severity-error"
        />
      );
    case 'skipped':
      return (
        <MdSkipNext size={15} aria-label="Skipped" className="mt-[1px] shrink-0 text-tp-stone" />
      );
    default:
      return (
        <MdRadioButtonUnchecked
          size={15}
          aria-label="Not run yet"
          className="mt-[1px] shrink-0 text-tp-muted"
        />
      );
  }
}

export function Collapsible({
  open,
  onToggle,
  label,
  children,
  bordered = true,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
  bordered?: boolean;
}) {
  return (
    <div className={bordered ? 'border-t border-tp-hairline-soft px-4 py-2' : 'py-1'}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-6 w-full cursor-pointer items-center justify-between text-[12px] font-medium text-tp-slate transition-colors hover:text-tp-ink"
      >
        {label}
        <MdExpandMore
          size={16}
          aria-hidden="true"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div className="pt-2 pb-1">{children}</div>}
    </div>
  );
}

/** A step's base in the card's own words, when the caller gives none. */
function baseText(step: ProposalStepView): string {
  if (step.kind === 'seal_derived')
    return 'Built on the composition’s latest version as it was, and on the exact document shown.';
  if (step.kind === 'adopt') return 'Built on the environment as it was when proposed.';
  return 'Built on what it names as it was when proposed.';
}

export function StepItem({
  step,
  running,
  renderDiff,
  describeBase,
  resultLink,
  renderDocument,
}: {
  step: ProposalStepView;
  running: boolean;
} & StepCallbacks) {
  const [comparing, setComparing] = useState(false);
  const [reading, setReading] = useState(false);
  const preview = step.preview ?? null;
  const link = step.status === 'done' ? (resultLink?.(step) ?? null) : null;
  const decided = step.deferred.length > 0 && step.dependsOn.length > 0;
  return (
    <li className="flex items-start gap-2 text-[12px]">
      <StepIcon status={step.status} running={running} />
      <div className="min-w-0 flex-1">
        <span className={step.status === 'skipped' ? 'text-tp-stone' : 'text-tp-ink-tint'}>
          {step.description}
        </span>
        {step.status === 'pending' && (
          <p className="m-0 text-[11px] text-tp-steel">
            {describeBase?.(step) ?? baseText(step)}
            {decided &&
              ` The ${step.deferred.join(' and ')} ${step.deferred.length === 1 ? 'is' : 'are'} decided when step ${step.dependsOn.join(' and ')} has run.`}
          </p>
        )}
        {step.error && (
          <p className="m-0 text-[11px] [overflow-wrap:anywhere] text-tp-severity-error">
            {`${step.error.message}${step.error.status ? ` (${step.error.status})` : ''}`}
          </p>
        )}
        {link && (
          <Link
            to={link.to}
            className="text-[11px] text-tp-accent underline decoration-dotted hover:text-tp-ink"
          >
            {link.label}
          </Link>
        )}
        {preview && step.status === 'pending' && (
          <div className="mt-1 flex flex-col">
            <Collapsible
              bordered={false}
              open={comparing}
              onToggle={() => setComparing(open => !open)}
              label={
                preview.against
                  ? `Compare with ${preview.against.environment ? `the version in effect in ${preview.against.environment.name}` : 'the latest version'} (${preview.against.version.label})`
                  : 'Compare with the version in effect'
              }
            >
              {preview.diff && renderDiff ? (
                renderDiff(preview.diff, step)
              ) : (
                <p className="m-0 text-[11px] text-tp-steel">
                  The comparison isn’t ready; read this again in a moment.
                </p>
              )}
            </Collapsible>
            {renderDocument && (
              <Collapsible
                bordered={false}
                open={reading}
                onToggle={() => setReading(open => !open)}
                label="Show the document"
              >
                {renderDocument(preview.document, step)}
              </Collapsible>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
