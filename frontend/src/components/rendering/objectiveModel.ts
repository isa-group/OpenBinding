export interface ObjectiveTerm {
  criterion: string;
  feature: string | null;
  direction: 'minimize' | 'maximize' | null;
  unit: string | null;
  value: number | null;
  loss: number | null;
  weight: number | null;
  /** loss × weight when both are numbers: a display aid, never a second score. */
  weighted: number | null;
}

/** Structural: the compiled problem read by the binding model fits as it is. */
export interface ObjectiveProblem {
  criteria: Array<{ id: string; direction: 'minimize' | 'maximize' | null }>;
  features?: Record<string, { unit: string | null }>;
}

export interface ObjectiveBreakdownData {
  terms: ObjectiveTerm[];
  penalty: number | null;
  score: number | Array<number | null> | null;
  scalarization: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function featureOf(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (isRecord(raw) && typeof raw.id === 'string') return raw.id;
  return null;
}

/** Reads the canonical objective evaluation of a solution; `null` when it is not canonical (nothing is guessed). */
// [impl->req~frontend-rendering-objective-breakdown~1]
export function objectiveTermsOf(objectives: unknown, problem: ObjectiveProblem | null): ObjectiveBreakdownData | null {
  if (!isRecord(objectives) || !Array.isArray(objectives.components)) return null;

  const terms = objectives.components.map((raw: unknown, index): ObjectiveTerm => {
    const c = isRecord(raw) ? raw : {};
    const criterion = typeof c.criteria === 'string' && c.criteria !== '' ? c.criteria : `criterion ${index + 1}`;
    const feature = featureOf(c.feature);
    const direction = problem?.criteria.find((k) => k.id === criterion)?.direction ?? null;
    const unit = (feature !== null && problem?.features?.[feature]?.unit) || null;
    const loss = num(c.loss);
    const weight = num(c.weight);
    return {
      criterion, feature, direction, unit, value: num(c.value), loss, weight,
      weighted: loss !== null && weight !== null ? loss * weight : null,
    };
  });

  const rawScore = objectives.score;
  const score = Array.isArray(rawScore) ? rawScore.map(num) : num(rawScore);
  return {
    terms,
    penalty: num(objectives.penalty),
    score,
    scalarization: typeof objectives.scalarization === 'string' ? objectives.scalarization : null,
  };
}
