// Adapted from SPHERE frontend/src/modules/core/utils/custom-confirm.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the dialog is queued for DialogHost (components/dialog-host), which mounts it in the React tree with a
// focus trap and Escape, instead of rendering it into a detached root.

import { requestDialog, type ConfirmOptions } from './dialog-queue';

function customConfirm(message: string, options: ConfirmOptions = {}): Promise<void> {
  return requestDialog({ kind: 'confirm', message, options }).then(confirmed => {
    if (!confirmed) throw undefined;
  });
}

export default customConfirm;
