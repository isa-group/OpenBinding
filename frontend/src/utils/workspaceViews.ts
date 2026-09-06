export type DiffLine = { kind: 'context' | 'added' | 'removed'; value: string };

function yamlScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

function yamlKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : JSON.stringify(value);
}

function yamlLines(value: unknown, depth = 0): string[] {
  const indent = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}[]`];
    return value.flatMap((item) => {
      if (item && typeof item === 'object') return [`${indent}-`, ...yamlLines(item, depth + 1)];
      return [`${indent}- ${yamlScalar(item)}`];
    });
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return [`${indent}{}`];
    return entries.flatMap(([key, item]) => {
      if (item && typeof item === 'object') return [`${indent}${yamlKey(key)}:`, ...yamlLines(item, depth + 1)];
      return [`${indent}${yamlKey(key)}: ${yamlScalar(item)}`];
    });
  }
  return [`${indent}${yamlScalar(value)}`];
}

/** Deterministic YAML 1.2 projection for the JSON documents accepted by BIM packages. */
export function toYaml(value: unknown): string {
  return `${yamlLines(value).join('\n')}\n`;
}

/** A compact, exact diff: shared edges stay context and the changed middle is replaced. */
export function sourceDiff(before: string, after: string): DiffLine[] {
  if (before === after) return before.split('\n').map((value) => ({ kind: 'context', value }));
  const left = before.split('\n');
  const right = after.split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1;
  return [
    ...left.slice(0, prefix).map((value): DiffLine => ({ kind: 'context', value })),
    ...left.slice(prefix, left.length - suffix).map((value): DiffLine => ({ kind: 'removed', value })),
    ...right.slice(prefix, right.length - suffix).map((value): DiffLine => ({ kind: 'added', value })),
    ...right.slice(right.length - suffix).map((value): DiffLine => ({ kind: 'context', value })),
  ];
}
