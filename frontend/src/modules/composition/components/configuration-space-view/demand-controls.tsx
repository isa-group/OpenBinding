// The calculator's demand (F4): a number of users, which has the gateway answer margins per plan, and the revision of the
// linked problem a binding is evaluated against (a demand variant: another revision of the same problem, whose recipe pinned
// other demand figures). SPHERE's configuration space has no demand; the controls are OpenBinding's fields. Nothing is saved
// from here: a new demand variant is a revision of the problem, made from its page ("Update from SPHERE").

import { Link } from 'react-router-dom';
import { useResource } from '../../../core/hooks/useResource';
import { problemsApi } from '../../../problem/api/problemsClient';
import { problemPath } from '../../../../routes/paths/problems';

interface Props {
  org: string;
  /** The linked problem and the revision the version links (`slug@N`). */
  problemRef: string;
  users: string;
  onUsers: (value: string) => void;
  /** The revision chosen; null for the one the version links. */
  revision: number | null;
  onRevision: (value: number | null) => void;
  /** Why the gateway refused the revision chosen last, in its words. */
  refusal: string | null;
}

export default function DemandControls({
  org,
  problemRef,
  users,
  onUsers,
  revision,
  onRevision,
  refusal,
}: Props) {
  const [problem, linkedText] = problemRef.split('@');
  const linked = linkedText ? Math.trunc(+linkedText) : null;
  const revisions = useResource(`demand-revisions:${org}/${problem}`, () =>
    problemsApi.revisions(org, problem).catch(() => [])
  );
  const others = (revisions.data ?? [])
    .map(item => item.revision)
    .filter(number => number !== linked)
    .sort((a, b) => b - a);
  const wizard = `${problemPath(org, problem)}?sphereStep=pricing&sphereUpdate=1`;

  return (
    <section
      aria-labelledby="demand-heading"
      className="flex flex-col gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-4"
    >
      <div>
        <h3 id="demand-heading" className="text-sm font-semibold text-tp-ink">
          Demand and margins
        </h3>
        <p className="text-xs text-tp-steel">
          Evaluate under another demand and see the margin per plan for a number of users. Nothing
          is saved from here.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-tp-ink">
          Users
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={1_000_000_000}
            value={users}
            onChange={event => onUsers(event.target.value)}
            placeholder="e.g. 1000"
            className="h-9 w-36 rounded-md border border-tp-input-border bg-tp-input-bg px-3 text-sm font-normal text-tp-ink outline-none focus:border-tp-primary"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-tp-ink">
          Demand
          <select
            value={revision === null ? '' : String(revision)}
            onChange={event =>
              onRevision(event.target.value === '' ? null : Math.trunc(+event.target.value))
            }
            className="h-9 min-w-56 cursor-pointer rounded-md border border-tp-input-border bg-tp-input-bg px-3 text-sm font-normal text-tp-ink outline-none focus:border-tp-primary"
          >
            <option value="">{`Problem version ${linked ?? ''}, as sealed`}</option>
            {others.map(number => (
              <option key={number} value={String(number)}>
                {`Problem version ${number}`}
              </option>
            ))}
          </select>
        </label>
        <Link
          to={wizard}
          className="inline-flex h-9 items-center text-xs font-medium text-tp-accent underline decoration-dotted hover:text-tp-ink"
        >
          New demand variant
        </Link>
      </div>
      {refusal && (
        <p role="alert" className="text-xs text-red-700">
          {`That problem version can’t evaluate this binding, so the demand went back to the version’s: ${refusal}`}
        </p>
      )}
    </section>
  );
}
