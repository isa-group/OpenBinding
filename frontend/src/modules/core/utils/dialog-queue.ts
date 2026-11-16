import type { Severity } from '../components/alert-modal';

export interface ConfirmOptions {
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** A dialog waiting to be shown by DialogHost, with the promise it settles. */
export type DialogRequest = {
  id: number;
  message: string;
  settle: (confirmed: boolean) => void;
} & ({ kind: 'confirm'; options: ConfirmOptions } | { kind: 'alert'; severity: Severity | 'auto' });

type Listener = (request: DialogRequest) => void;

let listener: Listener | null = null;
let pending: DialogRequest[] = [];
let counter = 0;

/** DialogHost listens here; requests made before it mounted are handed over at once. */
export function subscribeDialogs(next: Listener): () => void {
  listener = next;
  const waiting = pending;
  pending = [];
  waiting.forEach(next);
  return () => {
    if (listener === next) listener = null;
  };
}

type NewRequest =
  | { kind: 'confirm'; message: string; options: ConfirmOptions }
  | { kind: 'alert'; message: string; severity: Severity | 'auto' };

/** Queues a dialog and resolves with whether it was confirmed (an alert always resolves with true). */
export function requestDialog(request: NewRequest): Promise<boolean> {
  return new Promise(resolve => {
    const entry = { ...request, id: ++counter, settle: resolve } as DialogRequest;
    if (listener) listener(entry);
    else pending.push(entry);
  });
}
