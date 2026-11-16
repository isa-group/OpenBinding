// Adapted from SPHERE frontend/src/modules/core/components/copy-icon/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: theme tokens instead of SPHERE's palette module, its hex greens and the undefined `sphere-primary-800`;
// the icon strokes in currentColor; the field and the button are named.

import { useState } from 'react';

export default function CopyToClipboardIcon({ value }: { value: string }) {
  const [linkCopied, setLinkCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setLinkCopied(true);
      setTimeout(() => {
        setLinkCopied(false);
      }, 2000);
    });
  };

  return (
    <div
      className={`flex w-full overflow-hidden rounded-[5px] border ${linkCopied ? 'border-tp-success-strong' : 'border-tp-accent'}`}
    >
      <input
        value={value}
        readOnly
        aria-label="Value to copy"
        className="grow rounded-l-xs py-0 pr-0 pl-2 outline-none"
      />
      <button
        onClick={handleCopy}
        type="button"
        aria-label={linkCopied ? 'Copied' : 'Copy'}
        className={`flex h-10 w-10 min-w-0 cursor-pointer items-center justify-center rounded-r-xs py-1 text-tp-on-primary ${linkCopied ? 'bg-tp-success-strong' : 'bg-tp-accent'}`}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <rect fill="none"></rect>
          <rect
            x="4"
            y="8"
            width="12"
            height="12"
            rx="1"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
          ></rect>
          <path
            d="M8 6V5C8 4.44772 8.44772 4 9 4H19C19.5523 4 20 4.44772 20 5V15C20 15.5523 19.5523 16 19 16H18"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="2 2"
          ></path>
        </svg>
      </button>
    </div>
  );
}
