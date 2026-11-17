// Copied verbatim from SPHERE frontend/src/modules/pricing-editor/services/pricing2yaml/snippets/index.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.

export * from './types';
export * from './insert';
export {
  insertSnippet,
  registerSnippetActions,
  registerSnippetCompletions,
  registerTemplatesMenuAction,
  stripPlaceholders,
  templatesShortcutLabel,
} from './monaco';
