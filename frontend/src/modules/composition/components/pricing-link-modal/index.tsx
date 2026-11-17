// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-link-modal/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: drawn in OpenBinding's modal (a focus trap and Escape; SPHERE's had neither); the copy button names itself and
// turns to the success token instead of a hex green; the default description speaks of a composition's YAML file.

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { Modal } from '../../../core/components/modal';

interface PricingLinkModalProps {
  linkUrl: string;
  /** Replaces the default description (a direct link to the YAML file). */
  description?: string;
  onClose: () => void;
}

export default function PricingLinkModal({ linkUrl, description, onClose }: PricingLinkModalProps) {
  const [copied, setCopied] = useState(false);

  return (
    <Modal title="Your link is ready!" size="md" onClose={onClose}>
      <p className="text-center text-sm text-tp-steel">
        {description ??
          'This link points directly to the YAML file of the selected composition version. Tools that read Composition2Yaml can fetch it.'}
      </p>
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-tp-hairline-strong bg-tp-surface p-2">
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="truncate text-xs text-tp-ink">{linkUrl}</p>
        </div>
        <motion.button
          type="button"
          aria-label={copied ? 'Link copied' : 'Copy link'}
          onClick={() => {
            void navigator.clipboard?.writeText(linkUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className={`shrink-0 cursor-pointer rounded-md p-2 text-tp-on-primary transition-colors ${
            copied ? 'bg-tp-success-strong' : 'bg-tp-accent hover:bg-tp-primary-deep'
          }`}
        >
          <AnimatePresence mode="wait">
            {copied ? (
              <motion.svg
                key="check"
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </motion.svg>
            ) : (
              <motion.svg
                key="copy"
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
                />
              </motion.svg>
            )}
          </AnimatePresence>
        </motion.button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? 'Link copied to clipboard' : ''}
      </span>
      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer text-xs text-tp-steel hover:text-tp-ink"
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
