import { describeExpression, isAlways } from '../../entities/problem/expressions';
import type { ProblemFacts } from '../../shared/api/types';
import './RulesAndObjectives.css';

/**
 * The rules and objectives of a problem, from the facts of its compilation (A5) or of a checked package: each constraint with its
 * enforcement, its formula (`describeExpression`), when it applies, its penalty and where the package writes it; then the criteria
 * to optimize and what breaking a soft rule costs. Nothing is evaluated or weighed here: formulas and weights are printed as the
 * facts carry them. The problem page and the problem editor both show it.
 */

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const DIRECTIONS: Readonly<Record<string, string>> = {
  minimize: 'lower is better',
  maximize: 'higher is better',
};

/** Where the package writes a rule: its file and the JSON Pointer of the rule in it. */
export interface RuleOrigin {
  path: string;
  pointer: string;
}

interface Criterion {
  id: string;
  feature: string;
  direction: string;
  range: { min: number; max: number } | null;
}

interface Penalty {
  /** The constraint it prices, as the facts name constraints: `<resource>/<id>`. */
  rule: string;
  weight: number;
}

function criteriaOf(facts: ProblemFacts): Criterion[] {
  return facts.objectives.criteria.map((criterion, index) => {
    const normalize = record(criterion.normalize);
    const min = finite(normalize.min);
    const max = finite(normalize.max);
    const id = text(criterion.id) ?? `criterion ${index + 1}`;
    const direction = text(criterion.direction);
    return {
      id,
      feature: text(record(criterion.feature).id) ?? id,
      direction: (direction && DIRECTIONS[direction]) ?? 'direction not stated',
      range: min !== null && max !== null ? { min, max } : null,
    };
  });
}

function penaltiesOf(facts: ProblemFacts): Penalty[] {
  return facts.objectives.penalties.flatMap(penalty => {
    const constraint = record(penalty.constraint);
    const resource = text(constraint.resource);
    const id = text(constraint.id);
    const weight = finite(penalty.weight);
    return id && weight !== null ? [{ rule: resource ? `${resource}/${id}` : id, weight }] : [];
  });
}

interface ViewProps {
  facts: ProblemFacts;
  /** What the facts are of, in the copy: a stored problem version, or the package in an editor. */
  subject?: 'version' | 'package';
  /** Open a rule where the package writes it; without it the place is only named. */
  onOpenOrigin?: (origin: RuleOrigin) => void;
}

/** Where the package writes something, in words (`written in rules.json at /spec/constraints/sla`), or a button that opens it there. */
function WrittenIn({
  origin,
  rule,
  onOpen,
}: {
  origin: RuleOrigin;
  rule: string;
  onOpen?: (origin: RuleOrigin) => void;
}) {
  const place = (
    <>
      written in <code>{origin.path}</code> at <code>{origin.pointer}</code>
    </>
  );
  if (!onOpen) return <small className="ro-written">{place}</small>;
  return (
    <button
      type="button"
      className="ro-written ro-open"
      aria-label={`Open ${rule} in ${origin.path} at ${origin.pointer}`}
      onClick={() => onOpen(origin)}
    >
      {place}
    </button>
  );
}

function Rules({ facts, subject = 'version', onOpenOrigin }: ViewProps) {
  return (
    <section className="ro-panel" aria-labelledby="ro-rules">
      <h3 id="ro-rules">Rules</h3>
      {facts.constraints.length === 0 ? (
        <p className="ro-muted">{`This ${subject} declares no rules.`}</p>
      ) : (
        <ul className="ro-rules" aria-label={`Rules of this ${subject}`}>
          {facts.constraints.map(rule => (
            <li key={rule.id}>
              <span className={`ro-must${rule.enforcement === 'soft' ? ' is-should' : ''}`}>
                {rule.enforcement === 'hard' ? 'Must' : 'Should'}
              </span>
              <span>
                {describeExpression(rule.expression)}
                {rule.when !== null && !isAlways(rule.when) && (
                  <small> · when {describeExpression(rule.when)}</small>
                )}
                {rule.penalty !== null && (
                  <small> · penalty {describeExpression(rule.penalty)} if broken</small>
                )}
                <small className="ro-rule-id">
                  <code>{rule.id}</code> ·{' '}
                  {rule.enforcement === 'hard'
                    ? 'hard: a binding that breaks it is invalid'
                    : 'soft: a binding may break it, at a cost'}
                </small>
                {rule.origin && (
                  <WrittenIn origin={rule.origin} rule={rule.id} onOpen={onOpenOrigin} />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Objectives({ facts, subject = 'version' }: ViewProps) {
  const criteria = criteriaOf(facts);
  const penalties = penaltiesOf(facts);
  return (
    <section className="ro-panel" aria-labelledby="ro-objectives">
      <h3 id="ro-objectives">Objectives</h3>
      {criteria.length === 0 ? (
        <p className="ro-muted">{`This ${subject} declares no criteria to optimize.`}</p>
      ) : (
        <ul className="ro-criteria" aria-label="Criteria to optimize">
          {criteria.map(criterion => (
            <li key={criterion.id}>
              <span>
                <b>{criterion.id}</b>
                {criterion.feature !== criterion.id ? <small> ({criterion.feature})</small> : null}
              </span>
              <span>
                {criterion.direction}
                {criterion.range ? ` · scaled ${criterion.range.min}–${criterion.range.max}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {penalties.length > 0 && (
        <ul className="ro-criteria" aria-label="What breaking a soft rule costs">
          {penalties.map(penalty => (
            <li key={penalty.rule}>
              <span>
                Breaking <code>{penalty.rule}</code>
              </span>
              <span>costs weight {penalty.weight}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="ro-muted">{`How the criteria trade off against each other is chosen when ${subject === 'version' ? 'the version' : 'a saved version'} is run, so no weights are shown for them.`}</span>
    </section>
  );
}

/** The rules and objectives of a problem version (its Overview) or of the package in the problem editor. */
export function RulesAndObjectives(props: ViewProps) {
  return (
    <section className="ro" aria-labelledby="ro-title">
      <h2 id="ro-title">Rules and objectives</h2>
      <div className="ro-grid">
        <Rules {...props} />
        <Objectives {...props} />
      </div>
    </section>
  );
}
