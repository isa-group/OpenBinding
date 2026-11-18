import { useId } from 'react';
import type { TaskModel } from '../../utils/composition/viewModel';
import { providerGroups, type ProviderGroup } from './providerGroups';

interface ProviderMapProps {
  /** The composition's tasks, in workflow order, with what each is bound to. */
  tasks: readonly TaskModel[];
  /** How many distinct SPHERE pricings the candidates come from, as the gateway counted them (`analytics.upstreamPricings`). */
  upstreamPricings: number | null;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function upstreamText(count: number): string {
  return count === 0
    ? 'No candidate names the SPHERE pricing it comes from.'
    : `The candidates come from ${plural(count, 'SPHERE pricing', 'SPHERE pricings')}.`;
}

function GroupName({ group }: { group: ProviderGroup }) {
  switch (group.kind) {
    case 'provider':
      return <>{group.name}</>;
    case 'pricing':
      return (
        <>
          {group.name}{' '}
          <small className="pm-kind text-xs font-normal text-tp-steel">SPHERE pricing</small>
        </>
      );
    case 'in-house':
      return <>In-house</>;
    default:
      return (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">Provider not known</span>
        </>
      );
  }
}

/**
 * The SPHERE plan a task's candidate comes from: the plan and the add-ons, and the pricing when the group does not name it. The
 * pinned version is a SPHERE id, not a name: the upstream plan card says its name.
 */
function FromLine({ task, group }: { task: TaskModel; group: ProviderGroup }) {
  if (!task.from) return null;
  const { sphere, registry, plan, addons = [] } = task.from;
  const parts = [`plan ${plan}`];
  if (addons.length) parts.push(`add-ons ${addons.join(', ')}`);
  const pricing =
    group.kind === 'pricing' ? '' : `${sphere}${registry ? ` on ${registry}` : ''} · `;
  return (
    <small className="pm-from font-mono text-xs [overflow-wrap:anywhere] text-tp-steel">
      {pricing}
      {parts.join(' · ')}
    </small>
  );
}

function Group({ group }: { group: ProviderGroup }) {
  const title = useId();
  return (
    <li
      className={`pm-group is-${group.kind} flex min-w-0 flex-col gap-1.5 rounded-xl border p-3 [&_h3]:m-0 [&_h3]:flex [&_h3]:min-w-0 [&_h3]:flex-wrap [&_h3]:items-baseline [&_h3]:justify-between [&_h3]:gap-x-2 [&_h3]:gap-y-1 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:text-tp-ink ${
        group.kind === 'in-house'
          ? 'border-dashed border-tp-hairline bg-tp-surface'
          : 'border-tp-hairline bg-tp-canvas'
      }`}
    >
      <h3 id={title}>
        <span className="pm-name min-w-0 [overflow-wrap:anywhere]">
          <GroupName group={group} />
        </span>{' '}
        <span className="pm-count text-xs font-normal text-tp-steel">
          {plural(group.tasks.length, 'task', 'tasks')}
        </span>
      </h3>
      <ul
        className="pm-tasks m-0 flex list-none flex-col gap-1.5 p-0 [&>li]:flex [&>li]:min-w-0 [&>li]:flex-col [&>li]:gap-0.5"
        aria-labelledby={title}
      >
        {group.tasks.map(task => (
          <li key={task.id}>
            <span className="pm-task flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 [&_code]:font-mono [&_code]:text-[13px] [&_code]:[overflow-wrap:anywhere]">
              <code>{task.id}</code>
              {!task.local && (
                <>
                  <span className="pm-arrow text-tp-steel" aria-hidden="true">
                    →
                  </span>
                  {task.candidate ? (
                    <code>{task.candidate}</code>
                  ) : (
                    <span className="pm-muted m-0 text-[13px] text-tp-steel">Not bound</span>
                  )}
                </>
              )}
            </span>
            <FromLine task={task} group={group} />
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * The providers of a composition: its tasks grouped by who serves them (the problem's provider for a member who may read it,
 * else the SPHERE pricing a candidate comes from), with the SPHERE plan of each, and the tasks done in house apart.
 */
export function ProviderMap({ tasks, upstreamPricings }: ProviderMapProps) {
  const groups = providerGroups(tasks);
  return (
    <div className="pm flex min-w-0 flex-col gap-3">
      {upstreamPricings !== null && (
        <p className="pm-summary m-0 text-[13px] text-tp-steel">{upstreamText(upstreamPricings)}</p>
      )}
      {groups.length === 0 ? (
        <p className="pm-muted m-0 text-[13px] text-tp-steel">This version has no task.</p>
      ) : (
        <ul
          className="pm-groups m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 p-0"
          aria-label="Tasks by provider"
        >
          {groups.map(group => (
            <Group key={`${group.kind}:${group.name}`} group={group} />
          ))}
        </ul>
      )}
    </div>
  );
}
