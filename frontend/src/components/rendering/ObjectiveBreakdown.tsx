import { DataTable } from '../ui/DataTable';
import type { ObjectiveBreakdownData, ObjectiveTerm } from './objectiveModel';
import './ObjectiveBreakdown.css';

interface ObjectiveBreakdownProps extends ObjectiveBreakdownData {
  label?: string;
}

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const DIRECTION = { minimize: 'lower is better', maximize: 'higher is better' } as const;

function NoValue() {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">no value</span>
    </>
  );
}

function Num({ value }: { value: number | null }) {
  return value === null ? <NoValue /> : <>{number.format(value)}</>;
}

function Text({ value }: { value: string | null }) {
  return value === null ? <NoValue /> : <>{value}</>;
}

function scoreItemName(terms: ObjectiveTerm[], index: number): string {
  if (index < terms.length) return terms[index].criterion;
  return index === terms.length ? 'Penalty' : `Entry ${index + 1}`;
}

/** One solution's objective evaluation: score and penalty as the gateway gave them, and one row per objective term. */
// [impl->req~frontend-rendering-objective-breakdown~1]
export function ObjectiveBreakdown({ terms, penalty, score, scalarization, label = 'Objective breakdown' }: ObjectiveBreakdownProps) {
  const weighted = scalarization === 'weighted-sum';
  const showTotal = weighted && !Array.isArray(score);
  const columns = weighted ? 7 : 5;
  const total = terms.some((t) => t.weighted === null) ? null : terms.reduce((sum, t) => sum + (t.weighted ?? 0), 0);

  return (
    <section aria-label={label} className="rendering-objective">
      <dl className="rendering-objective__summary">
        <dt>Scalarization</dt>
        <dd><Text value={scalarization} /></dd>
        <dt>Score</dt>
        <dd>
          {Array.isArray(score) ? (
            <ol aria-label="Score" className="rendering-objective__scores">
              {score.map((entry, index) => (
                <li key={`${scoreItemName(terms, index)}-${index}`}>
                  {scoreItemName(terms, index)}: <Num value={entry} />
                </li>
              ))}
            </ol>
          ) : (
            <Num value={score} />
          )}
        </dd>
        <dt>Penalty</dt>
        <dd><Num value={penalty} /></dd>
      </dl>

      {terms.length === 0 ? (
        <p>No objective terms</p>
      ) : (
        <DataTable label="Objective terms">
          <thead>
            <tr>
              <th scope="col">Criterion</th>
              <th scope="col">Feature</th>
              <th scope="col">Direction</th>
              <th scope="col" className="is-number">Value</th>
              <th scope="col" className="is-number">Loss</th>
              {weighted && <th scope="col" className="is-number">Weight</th>}
              {weighted && <th scope="col" className="is-number">Weighted loss</th>}
            </tr>
          </thead>
          <tbody>
            {terms.map((t, index) => (
              <tr key={`${t.criterion}-${index}`}>
                <th scope="row">{t.criterion}</th>
                <td><Text value={t.feature} /></td>
                <td><Text value={t.direction === null ? null : DIRECTION[t.direction]} /></td>
                <td className="is-number">
                  <Num value={t.value} />
                  {t.value !== null && t.unit && <> {t.unit}</>}
                </td>
                <td className="is-number"><Num value={t.loss} /></td>
                {weighted && <td className="is-number"><Num value={t.weight} /></td>}
                {weighted && <td className="is-number"><Num value={t.weighted} /></td>}
              </tr>
            ))}
          </tbody>
          {showTotal && (
            <tfoot>
              <tr>
                <th scope="row" colSpan={columns - 1}>Total weighted loss</th>
                <td className="is-number"><Num value={total} /></td>
              </tr>
            </tfoot>
          )}
        </DataTable>
      )}
    </section>
  );
}
