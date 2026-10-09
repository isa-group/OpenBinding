/**
 * Turns a JSON Schema (or the OpenAPI document of the engine protocol) into a tree of fields a person can read:
 * what each field is called, what kind of value it holds, whether it is required, its unit, and the values it allows.
 * Nothing here prints the schema's JSON.
 */

export type Json = Record<string, unknown>;

export interface FieldNode {
  /** The key as written, or `[i]` for the entries of a list. */
  name: string;
  /** Where the field lives: `/spec/providers/{i}/id`. Copied by "Copy path". */
  path: string;
  /** Plain-language type: group, list, text, number, whole number, yes / no, choice. */
  type: string;
  required: boolean;
  unit: string | null;
  description: string;
  /** The values the field may take, when the schema lists them. */
  choices: string[];
  /** Other limits worth knowing, as short phrases: `at least 1`, `default 30000`, `format uri`. */
  facts: string[];
  children: FieldNode[];
}

const MAX_DEPTH = 7;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** `#/$defs/Metric` or `#/components/schemas/X`, looked up in the document the schema came from. */
function lookup(root: Json, ref: string): Json | null {
  if (!ref.startsWith('#/')) return null;
  let node: unknown = root;
  for (const token of ref.slice(2).split('/')) {
    const key = decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(node)) return null;
    node = node[key];
  }
  return isRecord(node) ? node : null;
}

interface Context {
  root: Json;
  /** Refs being expanded on the way down; a schema that contains itself stops here instead of looping. */
  stack: string[];
  /** Shared by the whole walk: a schema that fans out through many references stops growing at a readable size. */
  budget: { left: number };
}

const NODE_BUDGET = 3000;

/** A schema with `$ref` followed and `allOf` merged, so what is left describes one value. */
function resolve(schema: Json, context: Context): { node: Json; cycle: boolean; refName: string | null } {
  let node = schema;
  let refName: string | null = null;
  let guard = 0;
  while (typeof node.$ref === 'string' && guard < 8) {
    const ref = node.$ref;
    if (context.stack.includes(ref)) return { node, cycle: true, refName: ref.split('/').at(-1) ?? ref };
    const target = lookup(context.root, ref);
    if (!target) return { node, cycle: false, refName: ref.split('/').at(-1) ?? ref };
    refName = ref.split('/').at(-1) ?? ref;
    // Sibling keywords such as `description` next to a `$ref` still apply.
    const { $ref: _ignored, ...siblings } = node;
    void _ignored;
    node = { ...target, ...siblings };
    guard += 1;
  }
  if (Array.isArray(node.allOf)) {
    const merged: Json = { ...node };
    const properties: Json = isRecord(node.properties) ? { ...node.properties } : {};
    const required = new Set<string>(Array.isArray(node.required) ? node.required.filter((item): item is string => typeof item === 'string') : []);
    for (const part of node.allOf) {
      if (!isRecord(part)) continue;
      const inner = resolve(part, context).node;
      if (isRecord(inner.properties)) Object.assign(properties, inner.properties);
      if (Array.isArray(inner.required)) for (const item of inner.required) if (typeof item === 'string') required.add(item);
      if (typeof inner.type === 'string' && !merged.type) merged.type = inner.type;
      if (!merged.description && inner.description) merged.description = inner.description;
    }
    merged.properties = properties;
    merged.required = [...required];
    delete merged.allOf;
    node = merged;
  }
  return { node, cycle: false, refName };
}

const PLAIN: Record<string, string> = {
  object: 'group', array: 'list', string: 'text', number: 'number', integer: 'whole number', boolean: 'yes / no', null: 'empty',
};

function literal(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function factsOf(node: Json): string[] {
  const facts: string[] = [];
  const number = (key: string, label: (value: number) => string) => {
    const value = node[key];
    if (typeof value === 'number') facts.push(label(value));
  };
  number('minimum', (value) => `at least ${value}`);
  number('maximum', (value) => `at most ${value}`);
  number('exclusiveMinimum', (value) => `above ${value}`);
  number('exclusiveMaximum', (value) => `below ${value}`);
  number('minItems', (value) => `at least ${value} item${value === 1 ? '' : 's'}`);
  number('maxItems', (value) => `at most ${value} item${value === 1 ? '' : 's'}`);
  number('minLength', (value) => `at least ${value} character${value === 1 ? '' : 's'}`);
  number('maxLength', (value) => `at most ${value} character${value === 1 ? '' : 's'}`);
  if (typeof node.format === 'string') facts.push(`format ${node.format}`);
  if (typeof node.pattern === 'string') facts.push(`pattern ${node.pattern}`);
  if (node.uniqueItems === true) facts.push('items are unique');
  if (node.default !== undefined && (typeof node.default !== 'object' || node.default === null)) facts.push(`default ${literal(node.default)}`);
  return facts;
}

function typeOf(node: Json): { type: string; nullable: boolean } {
  const raw = node.type;
  if (Array.isArray(raw)) {
    const kinds = raw.filter((item): item is string => typeof item === 'string');
    const real = kinds.filter((item) => item !== 'null');
    return { type: PLAIN[real[0] ?? 'null'] ?? real[0] ?? 'value', nullable: kinds.includes('null') };
  }
  if (typeof raw === 'string') return { type: PLAIN[raw] ?? raw, nullable: false };
  if (isRecord(node.properties)) return { type: PLAIN.object, nullable: false };
  if (node.items !== undefined) return { type: PLAIN.array, nullable: false };
  return { type: 'value', nullable: false };
}

function build(schema: Json, name: string, path: string, required: boolean, depth: number, context: Context): FieldNode {
  context.budget.left -= 1;
  const { node: resolved, cycle, refName } = resolve(schema, context);
  const stack = typeof schema.$ref === 'string' && !cycle ? [...context.stack, schema.$ref] : context.stack;
  const inner: Context = { root: context.root, stack, budget: context.budget };
  let node = resolved;

  // `anyOf` / `oneOf`: a nullable value, a list of allowed literals, or genuinely different shapes.
  const variants = (Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : []).filter(isRecord);
  let alternatives: Json[] = [];
  const choices: string[] = [];
  if (Array.isArray(node.enum)) choices.push(...node.enum.map(literal));
  if (node.const !== undefined) choices.push(literal(node.const));
  if (variants.length > 0) {
    const real = variants.filter((variant) => variant.type !== 'null');
    const literals = real.every((variant) => variant.const !== undefined || Array.isArray(variant.enum));
    if (literals) {
      for (const variant of real) {
        if (variant.const !== undefined) choices.push(literal(variant.const));
        if (Array.isArray(variant.enum)) choices.push(...variant.enum.map(literal));
      }
    } else if (real.length === 1) {
      node = { ...resolve(real[0], inner).node, ...(node.description ? { description: node.description } : {}) };
    } else {
      alternatives = real;
    }
  }

  const kind = typeOf(node);
  const unit = text(node.unit) ?? text(node['x-unit']);
  const children: FieldNode[] = [];
  let type = choices.length === 1 && node.const !== undefined ? 'fixed value' : choices.length > 0 ? 'choice' : kind.type;
  if (alternatives.length > 0) type = `one of ${alternatives.length}`;

  if (depth < MAX_DEPTH && !cycle && context.budget.left > 0) {
    if (isRecord(node.properties)) {
      const requiredNames = new Set(Array.isArray(node.required) ? node.required.filter((item): item is string => typeof item === 'string') : []);
      for (const [key, value] of Object.entries(node.properties)) {
        if (isRecord(value)) children.push(build(value, key, `${path}/${key}`, requiredNames.has(key), depth + 1, inner));
      }
    }
    if (isRecord(node.items)) {
      children.push(build(node.items, '[i]', `${path}/{i}`, true, depth + 1, inner));
    } else if (Array.isArray(node.prefixItems)) {
      node.prefixItems.filter(isRecord).forEach((item, index) => children.push(build(item, `[${index}]`, `${path}/${index}`, true, depth + 1, inner)));
    }
    if (isRecord(node.additionalProperties)) {
      children.push(build(node.additionalProperties, '[key]', `${path}/{key}`, false, depth + 1, inner));
    }
    alternatives.forEach((variant, index) => {
      const label = text(variant.title) ?? text(resolve(variant, inner).refName) ?? `option ${index + 1}`;
      children.push(build(variant, label, `${path}/(${label})`, false, depth + 1, inner));
    });
  }

  const description = text(node.description) ?? text(node.title) ?? (cycle ? `Same structure as ${refName ?? 'its parent'}.` : '');
  return {
    name,
    path,
    type: kind.nullable && type !== 'empty' ? `${type}, may be empty` : type,
    required,
    unit,
    description: description || (refName && children.length > 0 ? refName : ''),
    choices,
    facts: factsOf(node),
    children,
  };
}

/** The fields at the top of a schema. For the engine protocol (an OpenAPI document) these are its component schemas. */
export function buildFieldTree(document: Json): FieldNode[] {
  const isProtocol = isRecord(document.openapi) && isRecord(document.openapi.components);
  const root = isProtocol ? document.openapi as Json : document;
  const context: Context = { root, stack: [], budget: { left: NODE_BUDGET } };
  if (isProtocol) {
    const schemas = isRecord((root.components as Json).schemas) ? (root.components as Json).schemas as Json : {};
    return Object.entries(schemas).filter((entry): entry is [string, Json] => isRecord(entry[1])).map(([name, schema]) => (
      build(schema, name, `/${name}`, false, 0, context)
    ));
  }
  // A schema that is only a reference or a single variant shows what that points to.
  if (!isRecord(root.properties)) return build(root, text(root.title) ?? 'schema', '', false, 0, context).children;
  const requiredNames = new Set(Array.isArray(root.required) ? root.required.filter((item): item is string => typeof item === 'string') : []);
  return Object.entries(root.properties).filter((entry): entry is [string, Json] => isRecord(entry[1])).map(([name, schema]) => (
    build(schema, name, `/${name}`, requiredNames.has(name), 0, context)
  ));
}

export interface SchemaFacts {
  identity: string | null;
  draft: string | null;
  rootFields: number;
  requiredAtRoot: number;
  definitions: number;
}

export function schemaFacts(document: Json): SchemaFacts {
  const isProtocol = isRecord(document.openapi);
  const root = isProtocol ? document.openapi as Json : document;
  const schemas = isProtocol && isRecord(root.components) && isRecord((root.components as Json).schemas) ? (root.components as Json).schemas as Json : null;
  const defs = isRecord(root.$defs) ? root.$defs : isRecord(root.definitions) ? root.definitions : null;
  return {
    identity: text(document.$id) ?? text(document.protocol),
    draft: text(document.$schema),
    rootFields: schemas ? Object.keys(schemas).length : isRecord(root.properties) ? Object.keys(root.properties).length : 0,
    requiredAtRoot: Array.isArray(root.required) ? root.required.length : 0,
    definitions: schemas ? Object.keys(schemas).length : defs ? Object.keys(defs).length : 0,
  };
}

export interface ProtocolOperation {
  method: string;
  path: string;
  summary: string;
}

/** The calls of the engine protocol (`bim-engine/v1`), for the table under its field tree. */
export function protocolOperations(document: Json): ProtocolOperation[] {
  const api = isRecord(document.openapi) ? document.openapi : null;
  const paths = api && isRecord(api.paths) ? api.paths : null;
  if (!paths) return [];
  return Object.entries(paths).flatMap(([path, item]) => {
    if (!isRecord(item)) return [];
    return ['get', 'post', 'put', 'patch', 'delete']
      .filter((method) => isRecord(item[method]))
      .map((method) => {
        const operation = item[method] as Json;
        return { method: method.toUpperCase(), path, summary: text(operation.summary) ?? text(operation.description) ?? '' };
      });
  });
}

export interface FlatRow {
  node: FieldNode;
  depth: number;
  hasChildren: boolean;
}

export type Expansion = 'default' | 'all' | 'none';

/**
 * The rows to draw. A branch is open when the person chose so; otherwise the first two levels are open, or
 * everything after "Expand all" and nothing after "Collapse all". Searching opens every branch that holds a match.
 */
export function flattenTree(
  nodes: FieldNode[],
  state: { mode: Expansion; overrides: Record<string, boolean>; query: string },
): Array<FlatRow & { matched: boolean }> {
  const needle = state.query.trim().toLowerCase();
  const rows: Array<FlatRow & { matched: boolean }> = [];
  const matches = (node: FieldNode): boolean => node.path.toLowerCase().includes(needle) || node.description.toLowerCase().includes(needle);
  const holdsMatch = (node: FieldNode): boolean => matches(node) || node.children.some(holdsMatch);

  const visit = (list: FieldNode[], depth: number) => {
    for (const node of list) {
      if (needle && !holdsMatch(node)) continue;
      const open = needle
        ? true
        : state.overrides[node.path] ?? (state.mode === 'all' ? true : state.mode === 'none' ? false : depth < 2);
      rows.push({ node, depth, hasChildren: node.children.length > 0, matched: Boolean(needle) && matches(node) });
      if (open && node.children.length > 0) visit(node.children, depth + 1);
    }
  };
  visit(nodes, 0);
  return rows;
}

/** Whether a branch is drawn open; mirrors {@link flattenTree}. */
export function isOpen(node: FieldNode, depth: number, state: { mode: Expansion; overrides: Record<string, boolean>; query: string }): boolean {
  if (state.query.trim()) return true;
  return state.overrides[node.path] ?? (state.mode === 'all' ? true : state.mode === 'none' ? false : depth < 2);
}
