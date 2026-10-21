import { useEffect, useState } from 'react';
import { Action } from '../ui/Action';
import { Notice } from '../ui/Notice';
import { forgetPlanChanged, peekPlanChanged, type PlanChangeNote } from '../../utils/authFlow';

/** The sentence for a plan the sign-in changed. Linking CAS raises BASIC to RESEARCH, and it costs nothing. */
function planChangedText(change: PlanChangeNote): string {
  const free = change.extraCost !== true;
  return `Your account is now on the ${change.to} plan.${free ? ' There is no extra cost.' : ''}`;
}

/**
 * Tells the person once, on the screen they land on after signing in, that signing in changed their plan. The note is read when
 * the screen opens and forgotten at once, so reloading doesn't show it again; Dismiss closes it for this visit.
 */
export function PlanChangedNotice({ className }: { className?: string }) {
  const [change, setChange] = useState<PlanChangeNote | null>(() => peekPlanChanged());

  useEffect(() => {
    forgetPlanChanged();
  }, []);

  if (!change) return null;
  return (
    <div className={className}>
      <Notice
        tone="success"
        title="Plan updated"
        action={<Action variant="secondary" size="sm" onClick={() => setChange(null)}>Dismiss</Action>}
      >
        {planChangedText(change)}
      </Notice>
    </div>
  );
}
