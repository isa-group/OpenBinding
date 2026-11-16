import { describeExpression, isAlways } from '../../entities/problem/expressions';
import type { ProblemFacts } from '../../shared/api/types';

/**
 * The rules and objectives of a problem version, from the facts of its compilation (A5): each constraint with its enforcement, its
 * formula (`describeExpression`), when it applies, its penalty and where the package writes it; then the criteria to optimize and
 * what breaking a soft rule costs. Nothing is evaluated or weighed here: formulas and weights are printed as the facts carry them.
 */

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

const DIRECTIONS: Readonly<Record<string, string>> = { minimize: 'lower is better', maximize: 'higher is better' };

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
  return facts.objectives.penalties.flatMap((penalty) => {
    const constraint = record(penalty.constraint);
    const resource = text(constraint.resource);
    const id = text(constraint.id);
    const weight = finite(penalty.weight);
    return id && weight !== null ? [{ rule: resource ? `${resource}/${id}` : id, weight }] : [];
  });
}

/** Where the package writes something, in words: `written in rules.json at /spec/constraints/sla`. */
const writtenIn = (origin: { path: string; pointer: string }) => <small className="case-written">written in <code>{origin.path}</code> at <code>{origin.pointer}</code></small>;

function Rules({ facts }: { facts: ProblemFacts }) {
  return (
    <section className="proj-panel" aria-labelledby="ro-rules">
      <h3 id="ro-rules">Rules</h3>
      {facts.constraints.length === 0 ? <p className="org-muted">This version declares no rules.</p> : (
        <ul className="case-rules" aria-label="Rules of this version">
          {facts.constraints.map((rule) => (
            <li key={rule.id}>
              <span className={`case-must${rule.enforcement === 'soft' ? ' is-should' : ''}`}>{rule.enforcement === 'hard' ? 'Must' : 'Should'}</span>
              <span>
                {describeExpression(rule.expression)}
                {rule.when !== null && !isAlways(rule.when) && <small> · when {describeExpression(rule.when)}</small>}
                {rule.penalty !== null && <small> · penalty {describeExpression(rule.penalty)} if broken</small>}
                <small className="case-rule-id">
                  <code>{rule.id}</code> · {rule.enforcement === 'hard' ? 'hard: a binding that breaks it is invalid' : 'soft: a binding may break it, at a cost'}
                </small>
                {rule.origin && writtenIn(rule.origin)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Objectives({ facts }: { facts: ProblemFacts }) {
  const criteria = criteriaOf(facts);
  const penalties = penaltiesOf(facts);
  return (
    <section className="proj-panel" aria-labelledby="ro-objectives">
      <h3 id="ro-objectives">Objectives</h3>
      {criteria.length === 0 ? <p className="org-muted">This version declares no criteria to optimize.</p> : (
        <ul className="case-criteria" aria-label="Criteria to optimize">
          {criteria.map((criterion) => (
            <li key={criterion.id}>
              <span><b>{criterion.id}</b>{criterion.feature !== criterion.id ? <small> ({criterion.feature})</small> : null}</span>
              <span>{criterion.direction}{criterion.range ? ` · scaled ${criterion.range.min}–${criterion.range.max}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {penalties.length > 0 && (
        <ul className="case-criteria" aria-label="What breaking a soft rule costs">
          {penalties.map((penalty) => (
            <li key={penalty.rule}>
              <span>Breaking <code>{penalty.rule}</code></span>
              <span>costs weight {penalty.weight}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="org-muted">How the criteria trade off against each other is chosen when the version is run, so no weights are shown for them.</span>
    </section>
  );
}

/** The Overview's rules and objectives of a problem version. */
export function RulesAndObjectives({ facts }: { facts: ProblemFacts }) {
  return (
    <section className="org-section" aria-labelledby="ro-title">
      <h2 id="ro-title">Rules and objectives</h2>
      <div className="case-rules-grid">
        <Rules facts={facts} />
        <Objectives facts={facts} />
      </div>
    </section>
  );
}
