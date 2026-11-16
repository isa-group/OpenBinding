// Adapted from SPHERE frontend/src/modules/core/components/action-button/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the white label sits on the accent, which reaches 4.5:1 (SPHERE's primary orange is 3.35:1).

import { motion } from 'framer-motion';

export default function ActionButton({
  text,
  onClick,
  disabled = false,
  className = '',
}: {
  text: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileHover={{ scale: !disabled ? 1.02 : 1 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className={`cursor-pointer rounded-md bg-tp-accent px-4 py-2 text-tp-on-primary hover:bg-tp-accent-hover disabled:cursor-not-allowed disabled:bg-tp-accent/50 ${className}`}
    >
      {text}
    </motion.button>
  );
}
