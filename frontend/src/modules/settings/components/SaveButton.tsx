// Adapted from SPHERE frontend/src/modules/settings/components/AccountSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's motion Save button (a spinner while saving, a check and "Saved" after) taken out so every section shares
// it; it sits on `tp-accent` so its white text passes contrast in both palettes, and it can submit a form.

import { motion } from 'framer-motion';
import { FiCheck, FiLoader } from 'react-icons/fi';

interface Props {
  saving: boolean;
  saved: boolean;
  disabled?: boolean;
  label?: string;
  /** `submit` inside a form; otherwise `onClick`. */
  type?: 'button' | 'submit';
  onClick?: () => void;
}

export default function SaveButton({
  saving,
  saved,
  disabled = false,
  label = 'Save changes',
  type = 'button',
  onClick,
}: Props) {
  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      type={type}
      onClick={onClick}
      disabled={disabled || saving}
      aria-busy={saving || undefined}
      className="flex cursor-pointer items-center gap-2 rounded-md bg-tp-accent px-4 py-2.5 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:cursor-not-allowed disabled:opacity-40"
    >
      {saving ? (
        <FiLoader className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : saved ? (
        <FiCheck className="h-4 w-4" aria-hidden="true" />
      ) : null}
      {saved ? 'Saved' : label}
    </motion.button>
  );
}
