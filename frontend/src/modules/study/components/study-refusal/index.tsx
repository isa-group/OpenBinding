// A refusal of the gateway about a study, in the theme's notice: what was refused, why, the lines it named, and the way to
// the plan when a larger plan would help.

import { Action } from '../../../core/components/action-button';
import { Chip } from '../../../core/components/chip';
import { Notice } from '../../../core/components/notice';
import type { Refusal } from '../../utils/studyErrors';

export function StudyRefusal({
  refusal,
  usageTo = false,
}: {
  refusal: Refusal;
  usageTo?: boolean;
}) {
  const plan =
    usageTo &&
    (refusal.kind === 'quota' ||
      (refusal.kind === 'busy' && refusal.source !== 'technical') ||
      refusal.kind === 'plan');
  return (
    <Notice
      tone={
        refusal.kind === 'plan' || refusal.kind === 'key' || refusal.kind === 'terminal'
          ? 'warning'
          : 'error'
      }
      title={refusal.title}
    >
      {refusal.text}
      {refusal.permission && refusal.kind === 'key' && (
        <>
          {' '}
          <Chip mono>{refusal.permission}</Chip>
        </>
      )}
      {refusal.details.map(line => (
        <span className="mt-1 block font-mono text-xs" key={line}>
          {line}
        </span>
      ))}
      {refusal.kind === 'range' && (
        <span className="mt-1 block">
          <Action to="/engines" variant="link" size="sm">
            Engines
          </Action>
        </span>
      )}
      {plan && (
        <span className="mt-1 flex flex-wrap gap-3">
          <Action to="/me/settings?section=plan" variant="link" size="sm">
            See your plan
          </Action>
          <Action to="/pricing" variant="link" size="sm">
            Compare plans
          </Action>
        </span>
      )}
    </Notice>
  );
}
