import { KINDS, type Kind } from './document';

/** The words a screen shows for each kind of composition: the only place they are written. */
export const KIND_LABELS: Readonly<Record<Kind, string>> = {
  application: 'Application',
  workflow: 'Workflow',
  pipeline: 'Pipeline',
  system: 'System',
};

export const kindLabel = (kind: Kind): string => KIND_LABELS[kind];

/** The kinds in the language reference's order, each with its label: for pickers and filters. */
export const KIND_OPTIONS: ReadonlyArray<{ id: Kind; label: string }> = KINDS.map(kind => ({
  id: kind,
  label: KIND_LABELS[kind],
}));

export const isKind = (value: string | null | undefined): value is Kind =>
  (KINDS as readonly string[]).includes(value ?? '');
