import { useMemo } from 'react';
import type { UpstreamEntry } from '../../../core/api/types';
import { Notice } from '../../../core/components/notice';
import PricingChangeReview from '../../../core/components/pricing-change-review';
import {
  compareProviderPlan,
  PROVIDER_PLAN_MESSAGES,
} from '../../../core/components/pricing-change-review/compare';
import { useResource } from '../../../core/hooks/useResource';
import { loadUpstream, type RendererUpstream } from '../../../core/utils/composition/upstream';
import { addOnsOf, field, upstreamChanges, type UpstreamChange } from './upstreamChanges';

const nameOf = (entry: UpstreamEntry) =>
  `${entry.snapshot?.title ?? field(entry, 'sphere')} ${field(entry, 'plan')}${entry.snapshot?.versionName ? `, version ${entry.snapshot.versionName}` : ''}`;

function Change({
  change,
  before,
  after,
}: {
  change: UpstreamChange;
  before: RendererUpstream;
  after: RendererUpstream;
}) {
  const beforeYaml = change.before.snapshot ? before.yaml[change.before.snapshot.id] : undefined;
  const afterYaml = change.after.snapshot ? after.yaml[change.after.snapshot.id] : undefined;
  const compared = useMemo(
    () =>
      beforeYaml !== undefined && afterYaml !== undefined
        ? compareProviderPlan(
            beforeYaml,
            afterYaml,
            field(change.before, 'plan'),
            addOnsOf(change.before),
            field(change.after, 'plan'),
            addOnsOf(change.after)
          )
        : null,
    [beforeYaml, afterYaml, change]
  );
  const title = `${change.task}: ${nameOf(change.before)} → ${nameOf(change.after)}`;
  if (!compared)
    return (
      <p className="text-[13px] text-tp-slate">
        {`${title}. OpenBinding holds no copy of one of the two versions, so the plans are shown by reference only.`}
      </p>
    );
  if (!compared.ok)
    return (
      <Notice tone="warning">{`${title}: the plans can’t be drawn, ${compared.reason}.`}</Notice>
    );
  return (
    <PricingChangeReview
      comparison={compared.comparison}
      title={title}
      messages={PROVIDER_PLAN_MESSAGES}
      readOnly
    />
  );
}

/**
 * The upstream plans that change between two versions of a composition: for a task whose binding entry pins another version or
 * plan of one provider, the plan change review over the two stored snapshots (both from the versions' upstream views), or the
 * references alone when a side has none. Stored data only.
 */
export default function UpstreamChanges({
  org,
  composition,
  from,
  to,
}: {
  org: string;
  composition: string;
  from: string;
  to: string;
}) {
  const pair = useResource<[RendererUpstream, RendererUpstream] | null>(
    `composition-upstream-pair:${org}/${composition}/${from}..${to}`,
    async () =>
      Promise.all([loadUpstream(org, composition, from), loadUpstream(org, composition, to)]).catch(
        () => null
      )
  );
  if (!pair.data) return null;
  const [before, after] = pair.data;
  const changes = upstreamChanges(before, after);
  if (changes.length === 0) return null;
  return (
    <section aria-label="Upstream plans that change" className="flex min-w-0 flex-col gap-3">
      <h3 className="text-sm font-semibold text-tp-ink">Upstream plans that change</h3>
      {changes.map(change => (
        <Change key={change.task} change={change} before={before} after={after} />
      ))}
    </section>
  );
}
