import { useId } from 'react';
import type { TaskModel } from '../../entities/composition/viewModel';
import { providerGroups, type ProviderGroup } from './providerGroups';
import './ProviderMap.css';

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
          {group.name} <small className="pm-kind">SPHERE pricing</small>
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

/** The SPHERE plan a task's candidate comes from: the plan, the pinned version and the add-ons, and the pricing when the group does not name it. */
function FromLine({ task, group }: { task: TaskModel; group: ProviderGroup }) {
  if (!task.from) return null;
  const { sphere, registry, plan, version, addons = [] } = task.from;
  const parts = [`plan ${plan}`, `version ${version}`];
  if (addons.length) parts.push(`add-ons ${addons.join(', ')}`);
  const pricing =
    group.kind === 'pricing' ? '' : `${sphere}${registry ? ` on ${registry}` : ''} · `;
  return (
    <small className="pm-from">
      {pricing}
      {parts.join(' · ')}
    </small>
  );
}

function Group({ group }: { group: ProviderGroup }) {
  const title = useId();
  return (
    <li className={`pm-group is-${group.kind}`}>
      <h3 id={title}>
        <span className="pm-name">
          <GroupName group={group} />
        </span>{' '}
        <span className="pm-count">{plural(group.tasks.length, 'task', 'tasks')}</span>
      </h3>
      <ul className="pm-tasks" aria-labelledby={title}>
        {group.tasks.map(task => (
          <li key={task.id}>
            <span className="pm-task">
              <code>{task.id}</code>
              {!task.local && (
                <>
                  <span className="pm-arrow" aria-hidden="true">
                    →
                  </span>
                  {task.candidate ? (
                    <code>{task.candidate}</code>
                  ) : (
                    <span className="pm-muted">Not bound</span>
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
    <div className="pm">
      {upstreamPricings !== null && <p className="pm-summary">{upstreamText(upstreamPricings)}</p>}
      {groups.length === 0 ? (
        <p className="pm-muted">This version has no task.</p>
      ) : (
        <ul className="pm-groups" aria-label="Tasks by provider">
          {groups.map(group => (
            <Group key={`${group.kind}:${group.name}`} group={group} />
          ))}
        </ul>
      )}
    </div>
  );
}
