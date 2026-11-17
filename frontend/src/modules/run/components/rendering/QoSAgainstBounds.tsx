import { Badge } from '../../../core/components/badge';
import { DataTable } from '../../../core/components/data-table';
import type { BoundOp, QoSBound, QoSRule } from './qosBoundsModel';

interface QoSAgainstBoundsProps {
  bounds: QoSBound[];
  rules: QoSRule[];
  label?: string;
}

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const SYMBOL: Record<BoundOp, string> = { lt: '<', lte: '≤', gt: '>', gte: '≥' };

const withUnit = (value: number, unit: string | null) =>
  unit ? `${number.format(value)} ${unit}` : number.format(value);

function margin(bound: QoSBound): string {
  if (bound.value === null) return '';
  const gap = Math.abs(bound.value - bound.limit);
  if (number.format(gap) === '0') return 'at the limit';
  return `${withUnit(gap, bound.unit)} ${bound.value < bound.limit ? 'below' : 'above'}`;
}

function Missing() {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">no value</span>
    </>
  );
}

function Status({
  met,
  enforcement,
  penalty,
}: {
  met: boolean | null;
  enforcement: 'hard' | 'soft';
  penalty?: number;
}) {
  const variant =
    met === null ? 'default' : met ? 'success' : enforcement === 'soft' ? 'warning' : 'error';
  return (
    <>
      <Badge variant={variant}>{met === null ? 'not checked' : met ? 'met' : 'violated'}</Badge>
      {penalty !== undefined && ` penalty ${number.format(penalty)}`}
    </>
  );
}

const kindOf = (enforcement: 'hard' | 'soft') => (enforcement === 'soft' ? 'should' : 'must');

/** Each bound of a solution with its value and margin, and the other rules as text; the status is the gateway's. */
export function QoSAgainstBounds({
  bounds,
  rules,
  label = 'QoS against bounds',
}: QoSAgainstBoundsProps) {
  const unchecked =
    bounds.length + rules.length > 0 && [...bounds, ...rules].every(row => row.met === null);

  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-3 text-tp-ink [&>p]:m-0 [&>p]:text-sm [&>p]:text-tp-steel"
    >
      {bounds.length + rules.length === 0 && <p>No rules to check.</p>}
      {unchecked && <p>Not checked: this solution carries no violations list from the gateway.</p>}
      {bounds.length > 0 && (
        <DataTable label="Bounds" minWidth={640}>
          <thead>
            <tr>
              {['Rule', 'Quality', 'Kind', 'Bound', 'Value', 'Margin', 'Status'].map(head => (
                <th key={head} scope="col">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bounds.map((bound, index) => (
              <tr key={`${index}-${bound.rule}`}>
                <td>
                  <code className="font-mono text-xs">{bound.rule}</code>
                </td>
                <td>{bound.feature}</td>
                <td>{kindOf(bound.enforcement)}</td>
                <td>{`${SYMBOL[bound.op]} ${withUnit(bound.limit, bound.unit)}`}</td>
                <td>{bound.value === null ? <Missing /> : withUnit(bound.value, bound.unit)}</td>
                <td>{bound.value === null ? <Missing /> : margin(bound)}</td>
                <td>
                  <Status met={bound.met} enforcement={bound.enforcement} penalty={bound.penalty} />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {rules.length > 0 && (
        <ul aria-label="Other rules" className="m-0 flex list-none flex-col gap-2 p-0">
          {rules.map((rule, index) => (
            <li
              key={`${index}-${rule.rule}`}
              className="min-w-0 rounded-lg border border-tp-hairline bg-tp-surface px-3 py-2 text-sm [overflow-wrap:anywhere]"
            >
              <code className="font-mono text-xs">{rule.rule}</code> <span>{rule.text}</span>
              {rule.when !== null && (
                <span className="text-xs text-tp-steel"> applies when {rule.when}</span>
              )}{' '}
              <span className="text-xs text-tp-steel">{kindOf(rule.enforcement)}</span>{' '}
              <Status met={rule.met} enforcement={rule.enforcement} penalty={rule.penalty} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
