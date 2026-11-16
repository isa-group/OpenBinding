// Adapted from SPHERE frontend/src/modules/core/components/alerts/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: framer-motion's AnimatePresence instead of react-transition-group (not a dependency here), messages
// keyed by their text instead of their index, the list derived in one update, and an alert role.

import { useEffect, useState, type JSX } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

export default function Alerts({ messages }: { messages: string[] }): JSX.Element {
  const [renderedMessages, setRenderedMessages] = useState<string[]>([]);

  useEffect(() => {
    // The rendered list follows `messages`: a message that left clears the list, new ones are appended.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRenderedMessages(previous => {
      const kept = previous.every(message => messages.includes(message)) ? previous : [];
      return [...kept, ...messages.filter(message => !kept.includes(message))];
    });
  }, [messages]);

  return (
    <div className="fixed right-0 bottom-0 w-dvw max-w-[500px] p-[10px]" role="alert">
      <AnimatePresence>
        {renderedMessages.map(message => (
          <motion.div
            key={message}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            className="mt-2 animate-alert-slide-in rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 shadow-sm"
          >
            {message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
