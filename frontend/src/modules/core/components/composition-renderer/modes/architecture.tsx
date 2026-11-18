import type { UpstreamEntry } from '../../../api/types';
import type { Provenance } from '../../../utils/composition/document';
import type { RendererUpstream } from '../../../utils/composition/upstream';
import type { CompositionViewModel } from '../../../utils/composition/viewModel';
import { PricingCard } from '../../pricing-card/PricingCard';
import { ProviderMap } from '../../provider-map/ProviderMap';
import type { Section } from '../presets';
import { RendererSection } from '../RendererSection';

/**
 * The architecture mode: who serves the composition. The providers its tasks are grouped by, and the upstream SPHERE plans its
 * candidates come from, one card per plan reference: drawn from the stored snapshot of the version it pins when the gateway
 * holds one (its upstream view), else the reference face.
 */

interface ArchitectureModeProps {
  model: CompositionViewModel;
  sections: readonly Section[];
  upstream?: RendererUpstream | null;
}

interface UpstreamPlan {
  reference: Provenance;
  /** The tasks whose candidate comes from this plan, in workflow order. */
  tasks: string[];
}

/** The identity of a reference, field by field as written: two tasks share a card only when every field is the same. */
const referenceKey = ({ sphere, registry = '', version, plan, addons = [] }: Provenance) =>
  [sphere, registry, version, plan, ...addons].join('\u0000');

/** Each distinct plan reference of the binding, in the order its first task appears. */
function upstreamPlans(model: CompositionViewModel): UpstreamPlan[] {
  const plans = new Map<string, UpstreamPlan>();
  for (const task of model.tasks) {
    if (!task.from) continue;
    const key = referenceKey(task.from);
    const plan = plans.get(key);
    if (plan) plan.tasks.push(task.id);
    else plans.set(key, { reference: task.from, tasks: [task.id] });
  }
  return [...plans.values()];
}

/** The upstream entry of a task that holds a stored snapshot, when the view has one. */
const snapshotted = (upstream: RendererUpstream | null | undefined, tasks: string[]) =>
  upstream?.view.entries.find(
    (entry: UpstreamEntry) => tasks.includes(entry.task) && entry.snapshot !== null
  ) ?? null;

export function ArchitectureMode({ model, sections, upstream = null }: ArchitectureModeProps) {
  if (!model.version) return null;
  const shows = (section: Section) => sections.includes(section);
  const plans = upstreamPlans(model);
  return (
    <>
      {shows('providers') && (
        <RendererSection title="Providers">
          <ProviderMap
            tasks={model.tasks}
            upstreamPricings={model.analytics?.upstreamPricings ?? null}
          />
        </RendererSection>
      )}
      {shows('plans') && (
        <RendererSection title="Upstream plans">
          {plans.length === 0 ? (
            <p className="cr-muted m-0 text-[13px] text-tp-steel">
              No candidate names the SPHERE plan it comes from.
            </p>
          ) : (
            <ul
              className="cr-plans m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 p-0 [&_code]:font-mono [&_code]:text-xs [&_code]:[overflow-wrap:anywhere] [&>li]:flex [&>li]:min-w-0 [&>li]:flex-col [&>li]:gap-1"
              aria-label="Upstream plans"
            >
              {plans.map(({ reference, tasks }) => {
                const entry = snapshotted(upstream, tasks);
                const yaml = entry?.snapshot ? upstream?.yaml[entry.snapshot.id] : undefined;
                return (
                  <li key={referenceKey(reference)}>
                    <PricingCard
                      reference={reference}
                      snapshot={entry?.snapshot ?? null}
                      yaml={yaml}
                    />
                    <p className="cr-muted m-0 text-[13px] text-tp-steel">
                      For{' '}
                      {tasks.map((task, index) => (
                        <span key={task}>
                          {index > 0 && ', '}
                          <code>{task}</code>
                        </span>
                      ))}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </RendererSection>
      )}
    </>
  );
}
