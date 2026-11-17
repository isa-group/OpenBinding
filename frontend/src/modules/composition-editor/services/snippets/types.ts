// Adapted from SPHERE frontend/src/modules/pricing-editor/services/pricing2yaml/snippets/types.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the top-level keys of a Composition2Yaml document instead of a pricing's sections.

/** Top-level keys of a Composition2Yaml document that can host a snippet, and `workflow`, which orders them. */
export type SnippetSection = 'problem' | 'workflow' | 'binding' | 'values' | 'offering';

/**
 * Canonical order of the top-level keys, used to place a key the document does not declare yet where a reader would expect
 * to find it.
 */
export const SECTION_ORDER: readonly SnippetSection[] = [
  'problem',
  'workflow',
  'binding',
  'values',
  'offering',
];

export type SnippetKind = 'block' | 'document';

/**
 * A ready-made piece of Composition2Yaml.
 *
 * `block` snippets describe one entry of a key (a task's binding, a value, ...) and are placed inside that key. `document`
 * snippets are whole compositions and replace the editor contents.
 *
 * Bodies are written in Monaco snippet syntax (`${1:placeholder}`, `${1|a,b|}`), with no leading indentation: the insertion
 * logic indents them to match the key they land in.
 */
export interface CompositionSnippet {
  id: string;
  /** Title shown in the templates menu. */
  label: string;
  /** What the user types in the editor to pull the snippet in. */
  prefix: string;
  /** One-liner shown next to the label. */
  detail: string;
  documentation: string;
  kind: SnippetKind;
  /** Required for `block` snippets, ignored for `document` ones. */
  section?: SnippetSection;
  /** Snippet body, or a factory when it depends on the moment of use. */
  body: string | (() => string);
}

/** Resolves the body of snippets whose contents depend on the moment of use. */
export function resolveSnippetBody(snippet: CompositionSnippet): string {
  return typeof snippet.body === 'function' ? snippet.body() : snippet.body;
}
