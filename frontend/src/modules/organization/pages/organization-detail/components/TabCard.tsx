// The panel of one tab of SPHERE's organization page (the card of frontend/src/modules/organization/pages/organization-detail/
// components/MembersTab.tsx and InvitationsTab.tsx, revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Pattern only: SPHERE's card (a hairline border, a display heading with a lede, the actions on the right), entering with
// its motion; its body is one live region, so a message that appears in it is read out.

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { transitionDefault } from '../../../../core/utils/motion-variants';

interface TabCardProps {
  /** The key AnimatePresence tells the tabs apart by. */
  id: string;
  title: string;
  lede: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export default function TabCard({ id, title, lede, actions, children }: TabCardProps) {
  return (
    <motion.section
      key={id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={transitionDefault}
      aria-label={title}
      className="rounded-xl border border-tp-hairline bg-tp-canvas"
    >
      <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg text-tp-ink">{title}</h2>
          <p className="text-xs text-tp-steel">{lede}</p>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="flex flex-col gap-4 px-5 py-4" aria-live="polite">
        {children}
      </div>
    </motion.section>
  );
}
