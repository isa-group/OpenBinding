// Adapted from SPHERE frontend/src/modules/pricing/components/configuration-space-view/configuration-comparison.tsx
// (feat/pricing-renderer, revision 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García
// Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: two bindings of a composition instead of two pricing selections. pricing-renderer's change review becomes a plain
// A/B table: the tasks bound differently, then the global values the toolchain computes for each side (`evaluate`), with
// whether the binding holds. As in SPHERE, there is no relation badge: two configurations a reader picked have no ladder.

import { useEffect, useState } from 'react';
import type { EvaluateResult } from '../../../core/api/types';
import type { WrittenBinding } from '../../../core/components/composition-renderer/modes/analysis';
import {
  analysisRefusal,
  type AnalysisRefusal,
} from '../../../core/components/composition-renderer/modes/analysis';
import { formatValue } from '../../../core/utils/composition/values';
import { compositionsApi } from '../../api/compositionsApi';
import { differingTasks } from './configurations';

export interface ConfigurationComparisonProps {
  org: string;
  slug: string;
  /** The version both bindings are of, by id. */
  version: string;
  a: WrittenBinding;
  b: WrittenBinding;
}

type Side =
  | { state: 'loading' }
  | { state: 'ready'; result: EvaluateResult }
  | { state: 'refused'; refusal: AnalysisRefusal };

function SideValue({ side, name }: { side: Side; name: string }) {
  if (side.state === 'loading') return <span className="text-tp-steel">…</span>;
  if (side.state === 'refused') return <span className="text-tp-steel">—</span>;
  const value = side.result.values[name];
  return value ? (
    <>{formatValue(Number(value.value), value.unit)}</>
  ) : (
    <span className="text-tp-steel">—</span>
  );
}

export default function ConfigurationComparison({
  org,
  slug,
  version,
  a,
  b,
}: ConfigurationComparisonProps) {
  const [sides, setSides] = useState<{ key: string; a: Side; b: Side } | null>(null);
  const key = JSON.stringify([org, slug, version, a, b]);

  useEffect(() => {
    let active = true;
    const evaluate = (binding: WrittenBinding): Promise<Side> =>
      compositionsApi.evaluate(org, slug, { version, binding }).then(
        result => ({ state: 'ready', result }),
        caught => ({
          state: 'refused',
          refusal: analysisRefusal(caught, 'The binding couldn’t be evaluated'),
        })
      );
    void Promise.all([evaluate(a), evaluate(b)]).then(([left, right]) => {
      if (active) setSides({ key, a: left, b: right });
    });
    return () => {
      active = false;
    };
  }, [org, slug, version, a, b, key]);

  const current =
    sides && sides.key === key
      ? sides
      : { a: { state: 'loading' } as Side, b: { state: 'loading' } as Side };
  const tasks = differingTasks(a, b);
  const names = [
    ...new Set(
      [current.a, current.b].flatMap(side =>
        side.state === 'ready' ? Object.keys(side.result.values) : []
      )
    ),
  ].sort();
  const cell = 'px-3 py-2 text-left text-xs';

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-tp-hairline">
        <table
          className="w-full min-w-[420px] border-collapse"
          aria-label="Tasks bound differently"
        >
          <thead className="bg-tp-surface text-tp-steel">
            <tr>
              <th scope="col" className={cell}>
                Task
              </th>
              <th scope="col" className={cell}>
                A
              </th>
              <th scope="col" className={cell}>
                B
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-tp-hairline">
            {tasks.length === 0 ? (
              <tr>
                <td colSpan={3} className={`${cell} text-tp-steel`}>
                  A and B are the same configuration.
                </td>
              </tr>
            ) : (
              tasks.map(task => (
                <tr key={task}>
                  <th scope="row" className={`${cell} font-mono font-medium text-tp-ink`}>
                    {task}
                  </th>
                  <td className={`${cell} font-mono text-red-800`}>{a[task] ?? 'none'}</td>
                  <td className={`${cell} font-mono text-emerald-800`}>{b[task] ?? 'none'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto rounded-lg border border-tp-hairline">
        <table className="w-full min-w-[420px] border-collapse" aria-label="Values of A and B">
          <thead className="bg-tp-surface text-tp-steel">
            <tr>
              <th scope="col" className={cell}>
                Value
              </th>
              <th scope="col" className={cell}>
                A
              </th>
              <th scope="col" className={cell}>
                B
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-tp-hairline">
            {names.map(name => (
              <tr key={name}>
                <th scope="row" className={`${cell} font-medium text-tp-ink`}>
                  {name}
                </th>
                <td className={cell}>
                  <SideValue side={current.a} name={name} />
                </td>
                <td className={cell}>
                  <SideValue side={current.b} name={name} />
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row" className={`${cell} font-medium text-tp-ink`}>
                Holds
              </th>
              {[current.a, current.b].map((side, index) => (
                <td key={index} className={cell}>
                  {side.state === 'ready'
                    ? side.result.valid
                      ? 'Yes'
                      : `No: ${side.result.violations.length} ${side.result.violations.length === 1 ? 'rule' : 'rules'} broken`
                    : side.state === 'refused'
                      ? side.refusal.message
                      : 'Evaluating…'}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-tp-steel">
        The toolchain evaluates both bindings on the problem version this one links; nothing is
        stored.
      </p>
    </div>
  );
}
