import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

// The pattern of pages/Organization/createDialog.ts for the creation dialog of a project: `New problem` over the problem list. That file
// types its kinds as organization and project, so the hook is repeated here; widening `CreateKind` there and importing it here is the follow-up.

export type CreateKind = 'problem';

/** The address that opens the creation dialog over the list at `base`. */
export const createAddress = (base: string, kind: CreateKind): string => `${base}?create=${kind}`;

/** The attribute that marks the control that opens a creation dialog: the focus goes back to it when the dialog is closed. */
export const OPENER = 'data-create-opener';

/**
 * The state of a creation dialog that lives in the address: open while the query holds `create=<kind>` and the person may create (`allowed`;
 * a viewer who types the address gets no dialog). `openDialog` adds the query; `close` goes back to `closeTo` replacing the entry, so Back does
 * not reopen the dialog. Once the dialog is gone the focus is back on the control that opened it (the Modal does that) or, when the address
 * opened the dialog, on the control that opens it.
 */
export function useCreateDialog(kind: CreateKind, closeTo: string, allowed: boolean) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const open = allowed && params.get('create') === kind;
  const wasOpen = useRef(open);

  useEffect(() => {
    // The Modal has already given the focus back to what held it when it opened; only a dialog opened by the address leaves it on the page.
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (wasOpen.current && !open && lost) document.querySelector<HTMLElement>(`[${OPENER}="${kind}"]`)?.focus();
    wasOpen.current = open;
  }, [open, kind]);

  return {
    open,
    openDialog: () => navigate(createAddress(closeTo, kind)),
    close: () => navigate(closeTo, { replace: true }),
  };
}
