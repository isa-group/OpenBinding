/**
 * Features and their aggregation policies (F of M'_C, Lambda of M_A).
 *
 * Two jobs. One is indexing: the model addresses features by position, so
 * every other encoder needs the same numbering. The other is the product
 * space: a feature that multiplies along the workflow is encoded in logs, so
 * the model can sum where the semantics multiply, and every value that feature
 * touches - candidate values and constraint bounds alike - has to go through
 * the same transform.
 */

/** How the model numbers the aggregation functions. */
const FN_CODE: Record<string, number> = {
  sum: 1,
  weighted_sum: 5,
  product: 2,
  max: 3,
  min: 4,
  scale_by_c: 1,
  scaled_sum: 1,
  scaled_product: 2,
};
const DEFAULT_FN = FN_CODE.sum;

export interface FeatureEncoding {
  /** 1-based index of each feature, as the model addresses them. */
  index: Record<string, number>;
  direction: Record<string, string>;
  range: Record<string, { min: number; max: number }>;
  usesProductSpace: Record<string, boolean>;
  /** Features a candidate serving k tasks splits between them, by id. */
  divided: Set<string>;
  /** Per feature, the aggregation function code for [task, seq, and, xor, loop]. */
  aggPolicy: number[][];
  /** Raw value to the space the model computes in. */
  toModelValue(value: number, featureId: string): number;
}

function usesProductSpace(instance: any, featureId: string): boolean {
  const compose = (instance.aggregation_policies?.[featureId]?.compose || {}) as Record<string, any>;
  return [compose.seq?.fn, compose.and?.fn, compose.xor?.fn, compose.loop?.fn]
    .map((fn: any) => String(fn || '').toLowerCase())
    .some((fn) => fn === 'product' || fn === 'scaled_product');
}

export function encodeFeatures(instance: any, features: string[]): FeatureEncoding {
  const definitions = instance.features || [];

  const direction: Record<string, string> = {};
  const range: Record<string, { min: number; max: number }> = {};
  for (const definition of definitions) {
    direction[definition.id] = (definition.direction || 'MINIMIZE').toUpperCase();
    const valid = definition.valid_range || {};
    range[definition.id] = { min: Number(valid.min ?? 0.0), max: Number(valid.max ?? 1.0) };
  }

  const index: Record<string, number> = {};
  features.forEach((feature, i) => (index[feature] = i + 1));

  // A DIVIDE feature is paid once for the candidate itself, so the k tasks
  // sharing it carry v/k each instead of v.
  const divided = new Set<string>(
    definitions
      .filter((definition: any) => String(definition.sharing || 'REPLICATE').toUpperCase() === 'DIVIDE')
      .map((definition: any) => definition.id)
  );

  const productSpace: Record<string, boolean> = {};
  for (const feature of features) {
    productSpace[feature] = usesProductSpace(instance, feature);
  }

  const toModelValue = (value: number, featureId: string): number => {
    const finite = Number.isFinite(value) ? value : 0.0;
    if (!productSpace[featureId]) {
      return finite;
    }
    return Math.log(Math.max(1e-12, finite));
  };

  const aggPolicy: number[][] = features.map((feature) => {
    const compose = ((instance.aggregation_policies || {})[feature] || {}).compose || {};
    const code = (raw: any): number => {
      const fn = String(raw || '').toLowerCase();
      // In log space a product becomes a sum, so the model is told to add.
      if (productSpace[feature] && (fn === 'product' || fn === 'scaled_product')) {
        return FN_CODE.sum;
      }
      return FN_CODE[fn] || DEFAULT_FN;
    };
    return [
      DEFAULT_FN, // TASK: leaves carry their own value
      code(compose.seq?.fn),
      code(compose.and?.fn),
      code(compose.xor?.fn),
      code(compose.loop?.fn),
    ];
  });

  return { index, direction, range, usesProductSpace: productSpace, divided, aggPolicy, toModelValue };
}
