import ts from 'typescript';

// The source scanner of the vocabulary rule (`req~frontend-nav-vocabulary-text~1`): finds the forbidden words in the TEXT that a source file
// puts on screen, without rendering it. The words are a parameter (`wordPattern`), so each slice of M2.6 scans its own area with the words it
// has retired. Rendered text that this scan cannot see (composed at run time) is the route smoke's job.
//
// What is reported, as whole words in any letter case:
//   (a) JSX text;
//   (b) the string literals of a JSX child expression (`{ok ? 'Cases' : ''}`);
//   (c) a text-like JSX attribute (`label`, `title`, `aria-label`, `placeholder`, `alt`, `crumb`, `heading`, ...), single words included;
//   (d) a text-like object property (`{ label: 'Cases' }`), single words included;
//   (e) any string literal or template of two or more words.
// A single plain word anywhere else is not reported (`kind === 'case'`, `className="case"`, a route parameter, an identifier).
// Left out: imports and exports, types, comments, paths and URLs, tokens joined by `-`, `_` or `/` in a multi-word literal (class lists),
// the subtree of a `code` element, of `SourceView` and of `LogPanel`.
// Known limits: text assembled by a call (`plural(n, 'case')`) or kept in a variable and rendered later is not seen.

/** One place where a source file shows a forbidden word. */
export interface Finding {
  file: string;
  line: number;
  /** The kind of place: `JSX text`, `JSX expression`, `attribute label`, `property label` or `string`. */
  where: string;
  /** The text, with each substitution of a template shown as `X`, cut at 80 characters. */
  text: string;
}

/** The attributes and object properties whose value is text that a person reads. */
export const TEXT_PROPS: ReadonlySet<string> = new Set([
  'label', 'title', 'aria-label', 'ariaLabel', 'aria-description', 'placeholder', 'alt', 'crumb', 'heading', 'description', 'hint', 'text',
  'message', 'summary', 'caption', 'subtitle', 'tooltip', 'legend', 'error', 'empty', 'confirmLabel', 'helper', 'note',
]);

/** The elements whose subtree the rule leaves out. */
const EXEMPT_TAGS: ReadonlySet<string> = new Set(['code', 'SourceView', 'LogPanel']);

const escapeRegExp = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern of the given words as whole words in any letter case. It has no `g` flag, so `test` keeps no state. */
// [impl->req~frontend-nav-vocabulary-text~1]
export const wordPattern = (words: readonly string[]): RegExp => new RegExp(`\\b(?:${words.map(escapeRegExp).join('|')})\\b`, 'i');

/** True for a file that is not application code: tests, test kits and utilities, fixtures, declarations and everything under `test/`. */
export const isTestSupport = (path: string): boolean => (
  /(\.test\.[cm]?[jt]sx?$|[Tt]est[Kk]it\.[jt]sx?$|[Tt]est[Uu]tils\.[jt]sx?$|\.d\.ts$|(^|\/)fixtures?\.[jt]sx?$|(^|\/)(test|__tests__|fixtures)\/)/
).test(path);

const PATH_LIKE = /^\s*(?:https?:|mailto:|\/|\.{1,2}\/|#)|:\/\//;

/** The operators whose two operands both reach the screen: `a + b`, `a || b`, `a ?? b`. (`a && b` shows only `b`.) */
const JOINS: readonly ts.SyntaxKind[] = [ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken];

const wordsOf = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

function stringValue(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `X${span.literal.text}`).join('');
  return undefined;
}

/** The string literals and templates that make up the value of an expression, without entering calls, functions or JSX. */
function valueStrings(expression: ts.Node | undefined, out: ts.Node[] = []): ts.Node[] {
  if (!expression) return out;
  if (stringValue(expression) !== undefined) out.push(expression);
  else if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression) || ts.isJsxExpression(expression)) valueStrings(expression.expression, out);
  else if (ts.isConditionalExpression(expression)) {
    valueStrings(expression.whenTrue, out);
    valueStrings(expression.whenFalse, out);
  } else if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) valueStrings(expression.right, out);
    else if (JOINS.includes(operator)) {
      valueStrings(expression.left, out);
      valueStrings(expression.right, out);
    }
  } else if (ts.isArrayLiteralExpression(expression)) expression.elements.forEach((element) => valueStrings(element, out));
  return out;
}

const tagOf = (node: ts.Node): string | undefined => {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return undefined;
};

const propertyName = (name: ts.PropertyName): string | undefined => (
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
);

/**
 * The places in `source` that show a word of `words` (see `wordPattern`). `file` names the file in the findings and tells TSX from TS by its
 * extension.
 */
// [impl->req~frontend-nav-vocabulary-text~1]
export function scanSource(source: string, words: RegExp, file = 'source.tsx'): Finding[] {
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, kind);
  const found = new Map<number, Finding>();

  const report = (node: ts.Node, where: string, value: string) => {
    const start = node.getStart(tree);
    if (found.has(start) || PATH_LIKE.test(value) || !words.test(value)) return;
    found.set(start, { file, line: tree.getLineAndCharacterOfPosition(start).line + 1, where, text: value.trim().replace(/\s+/g, ' ').slice(0, 80) });
  };
  const reportValue = (expression: ts.Node | undefined, where: string) => {
    for (const node of valueStrings(expression)) report(node, where, stringValue(node) ?? '');
  };
  const reportProse = (node: ts.Node) => {
    const value = stringValue(node);
    if (value === undefined || PATH_LIKE.test(value)) return;
    // Prose: two or more words, of which at least one is not joined by `-`, `_` or `/` (class names, identifiers, paths).
    const prose = wordsOf(value).filter((token) => !/[-_/\\]/.test(token));
    if (wordsOf(value).length >= 2 && prose.length >= 1) report(node, 'string', prose.join(' '));
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isTypeNode(node)
      || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
    const tag = tagOf(node);
    if (tag !== undefined && EXEMPT_TAGS.has(tag)) return;
    if (ts.isJsxText(node)) {
      report(node, 'JSX text', node.text);
      return;
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(tree);
      if (TEXT_PROPS.has(name)) reportValue(node.initializer, `attribute ${name}`);
      else if (node.initializer && ts.isStringLiteral(node.initializer)) return;
    } else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      reportValue(node.expression, 'JSX expression');
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== undefined && TEXT_PROPS.has(name)) reportValue(node.initializer, `property ${name}`);
    }
    reportProse(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/** `file:line  where: "text"`. */
export const formatFinding = (finding: Finding): string => `${finding.file}:${finding.line}  ${finding.where}: "${finding.text}"`;

/**
 * The findings of many files (path to source). Test files, test kits, fixtures and declarations are not application code and are skipped.
 * `.ts` and `.tsx` files only.
 */
// [impl->req~frontend-nav-vocabulary-text~1]
export function scanFiles(files: Readonly<Record<string, string>>, words: RegExp): Finding[] {
  return Object.keys(files).sort()
    .filter((path) => /\.tsx?$/.test(path) && !isTestSupport(path))
    .flatMap((path) => scanSource(files[path], words, path));
}
