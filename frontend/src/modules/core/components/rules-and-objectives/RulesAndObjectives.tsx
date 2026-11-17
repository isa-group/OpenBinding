import { describeExpression, isAlways } from '../../utils/problem/expressions';
import type { ProblemFacts } from '../../api/types';

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

const PANEL = 'flex min-w-0 flex-col gap-3 rounded-2xl border border-tp-hairline bg-tp-canvas p-4';
const CRITERION = 'flex flex-wrap justify-between gap-2 text-[13px] text-tp-ink';

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
      written in <code className="font-mono">{origin.path}</code> at{' '}
      <code className="font-mono">{origin.pointer}</code>
    </>
  );
  if (!onOpen)
    return (
      <small className="block text-[11px] [overflow-wrap:anywhere] text-tp-steel">{place}</small>
    );
  return (
    <button
      type="button"
      className="block cursor-pointer text-left text-[11px] [overflow-wrap:anywhere] text-tp-link underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tp-primary"
      aria-label={`Open ${rule} in ${origin.path} at ${origin.pointer}`}
      onClick={() => onOpen(origin)}
    >
      {place}
    </button>
  );
}

function Rules({ facts, subject = 'version', onOpenOrigin }: ViewProps) {
  return (
    <section className={PANEL} aria-labelledby="ro-rules">
      <h3 id="ro-rules" className="text-[15px] font-semibold text-tp-ink">
        Rules
      </h3>
      {facts.constraints.length === 0 ? (
        <p className="text-sm text-tp-steel">{`This ${subject} declares no rules.`}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={`Rules of this ${subject}`}>
          {facts.constraints.map(rule => (
            <li key={rule.id} className="flex items-baseline gap-2 text-[13px] text-tp-ink">
              <span
                className={`flex-none rounded px-1.5 py-px text-[11px] font-semibold ${rule.enforcement === 'soft' ? 'border border-tp-ink text-tp-ink' : 'bg-tp-ink text-tp-on-primary'}`}
              >
                {rule.enforcement === 'hard' ? 'Must' : 'Should'}
              </span>
              <span>
                {describeExpression(rule.expression)}
                {rule.when !== null && !isAlways(rule.when) && (
                  <small className="ml-1 text-[11px] text-tp-steel">
                    · when {describeExpression(rule.when)}
                  </small>
                )}
                {rule.penalty !== null && (
                  <small className="ml-1 text-[11px] text-tp-steel">
                    · penalty {describeExpression(rule.penalty)} if broken
                  </small>
                )}
                <small className="block text-[11px] text-tp-steel">
                  <code className="font-mono">{rule.id}</code> ·{' '}
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
    <section className={PANEL} aria-labelledby="ro-objectives">
      <h3 id="ro-objectives" className="text-[15px] font-semibold text-tp-ink">
        Objectives
      </h3>
      {criteria.length === 0 ? (
        <p className="text-sm text-tp-steel">{`This ${subject} declares no criteria to optimize.`}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Criteria to optimize">
          {criteria.map(criterion => (
            <li key={criterion.id} className={CRITERION}>
              <span>
                <b>{criterion.id}</b>
                {criterion.feature !== criterion.id ? (
                  <small className="text-tp-steel"> ({criterion.feature})</small>
                ) : null}
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
        <ul className="flex flex-col gap-2" aria-label="What breaking a soft rule costs">
          {penalties.map(penalty => (
            <li key={penalty.rule} className={CRITERION}>
              <span>
                Breaking <code className="font-mono">{penalty.rule}</code>
              </span>
              <span>costs weight {penalty.weight}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="text-sm text-tp-steel">{`How the criteria trade off against each other is chosen when ${subject === 'version' ? 'the version' : 'a saved version'} is run, so no weights are shown for them.`}</span>
    </section>
  );
}

/** The rules and objectives of a problem version (its Overview) or of the package in the problem editor. */
export function RulesAndObjectives(props: ViewProps) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="ro-title">
      <h2 id="ro-title" className="text-lg font-medium text-tp-ink">
        Rules and objectives
      </h2>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] items-start gap-4">
        <Rules {...props} />
        <Objectives {...props} />
      </div>
    </section>
  );
}
