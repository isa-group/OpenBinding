import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import { languageApi } from '../../entities/composition/api';
import type { ProblemFacts } from '../../shared/api/types';
import { cursorPlace, ITEM, type CursorPlace } from './yamlText';

/**
 * What the code editor offers while typing a Composition2Yaml document. Keys come from the JSON Schema the gateway serves
 * (`GET /v1/compositions/schema`), walked along the key path at the cursor; with the facts of the linked problem, binding keys
 * are its task ids, a task's `candidate:` its eligible candidates as the problem writes them, `values:` keys its features and a
 * value's `unit:` that feature's unit. It only offers: the gateway judges the text, and no rule of the language is written here.
 */

/** A JSON Schema, as far as completion reads it. */
export type JsonSchema = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

let schemaOnce: Promise<JsonSchema> | null = null;

/** The schema of Composition2Yaml 1.0, read from the gateway once per page. */
export function compositionSchema(): Promise<JsonSchema> {
  if (!schemaOnce) {
    schemaOnce = languageApi.schema().catch((reason: unknown) => {
      schemaOnce = null;
      throw reason;
    });
  }
  return schemaOnce;
}

/** Forget the schema read so far (tests start without one). */
export function forgetCompositionSchema(): void {
  schemaOnce = null;
}

/** `#/$defs/name` of the root schema. */
function deref(root: JsonSchema, node: JsonSchema): JsonSchema {
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let at: unknown = root;
  for (const part of ref.slice(2).split('/')) at = isRecord(at) ? at[part] : undefined;
  return isRecord(at) ? at : {};
}

/** The schemas a node stands for: itself, or each alternative of a `oneOf`/`anyOf`, references followed. */
function alternatives(
  root: JsonSchema,
  node: JsonSchema,
  seen = new Set<JsonSchema>()
): JsonSchema[] {
  const resolved = deref(root, node);
  if (seen.has(resolved)) return [];
  seen.add(resolved);
  const options = [
    ...(Array.isArray(resolved.oneOf) ? resolved.oneOf : []),
    ...(Array.isArray(resolved.anyOf) ? resolved.anyOf : []),
  ].filter(isRecord);
  return options.length ? options.flatMap(option => alternatives(root, option, seen)) : [resolved];
}

/** The schemas at a key path, every alternative followed. */
function schemasAt(root: JsonSchema, path: readonly string[]): JsonSchema[] {
  let current = alternatives(root, root);
  for (const step of path) {
    current = current.flatMap((node): JsonSchema[] => {
      if (step === ITEM) return isRecord(node.items) ? alternatives(root, node.items) : [];
      const properties = isRecord(node.properties) ? node.properties : {};
      if (isRecord(properties[step])) return alternatives(root, properties[step] as JsonSchema);
      return isRecord(node.additionalProperties)
        ? alternatives(root, node.additionalProperties)
        : [];
    });
  }
  return current;
}

/** The keys the schema names at a key path, in its order and once each. */
export function schemaKeys(root: JsonSchema, path: readonly string[]): string[] {
  const keys = schemasAt(root, path).flatMap(node =>
    isRecord(node.properties) ? Object.keys(node.properties) : []
  );
  return [...new Set(keys)];
}

/** The fixed values the schema allows at a key path (`enum`, `const`), as YAML writes them. */
export function schemaValues(root: JsonSchema, path: readonly string[]): string[] {
  const values = schemasAt(root, path).flatMap(node => [
    ...(Array.isArray(node.enum) ? node.enum : []),
    ...('const' in node ? [node.const] : []),
  ]);
  return [
    ...new Set(
      values.map(value =>
        typeof value === 'string' && /^\d/.test(value) ? `"${value}"` : String(value)
      )
    ),
  ];
}

const describe = (root: JsonSchema, path: readonly string[]): string | undefined => {
  const node = schemasAt(root, path).find(item => typeof item.description === 'string');
  return node ? String(node.description) : undefined;
};

export interface CompletionFacts {
  schema: JsonSchema | null;
  /** The facts of the problem the draft links, when the editor could read them. */
  facts: ProblemFacts | null;
}

/** What to offer at a place, from the facts first and the schema second. */
function offered(place: CursorPlace, { schema, facts }: CompletionFacts): Completion[] {
  const { path, at } = place;
  const [section, name] = path;
  const keyOption = (label: string, detail?: string, info?: string): Completion => ({
    label,
    type: 'property',
    apply: `${label}: `,
    detail,
    info,
  });
  const valueOption = (label: string, detail?: string): Completion => ({
    label,
    type: 'constant',
    detail,
  });

  if (facts && at === 'key' && path.length === 1 && section === 'binding') {
    return facts.tasks.map(task =>
      keyOption(task.id, task.kind === 'local' ? 'local task' : 'task')
    );
  }
  if (facts && at === 'key' && path.length === 1 && section === 'values') {
    return facts.features.map(feature =>
      keyOption(feature.id, feature.unit && feature.unit !== '1' ? feature.unit : undefined)
    );
  }
  if (
    facts &&
    at === 'value' &&
    section === 'binding' &&
    path.length === 3 &&
    path[2] === 'candidate'
  ) {
    const task = facts.tasks.find(item => item.id === name);
    return (task?.eligible ?? []).map(eligible => valueOption(eligible.written, 'eligible'));
  }
  if (facts && at === 'value' && section === 'values' && path.length === 3 && path[2] === 'unit') {
    const feature = facts.features.find(item => item.id === name);
    return feature ? [valueOption(feature.unit, 'the problem’s unit')] : [];
  }
  if (!schema) return [];
  if (at === 'key')
    return schemaKeys(schema, path).map(key =>
      keyOption(key, undefined, describe(schema, [...path, key]))
    );
  return schemaValues(schema, path).map(value => valueOption(value));
}

/** The completion at `pos` of `text`: where the word being written starts and what may replace it, or null. */
export function completionAt(
  text: string,
  pos: number,
  sources: CompletionFacts
): { from: number; options: Completion[] } | null {
  const place = cursorPlace(text, pos);
  const options = offered(place, sources);
  return options.length ? { from: place.from, options } : null;
}

/** The completion source of the code editor over these sources. */
export function compositionCompletions(sources: CompletionFacts): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const found = completionAt(context.state.doc.toString(), context.pos, sources);
    if (!found) return null;
    return { from: found.from, options: found.options, validFor: /^[^\s:,{}[\]#]*$/ };
  };
}
