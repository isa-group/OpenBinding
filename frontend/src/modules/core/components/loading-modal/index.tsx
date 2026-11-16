// Adapted from SPHERE frontend/src/modules/core/components/loading-modal/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the banter loader by default (SPHERE's collection loader ships its own stylesheet), a neutral default
// message, a status role, and the canvas token for the panel.

import type { JSX } from 'react';
import BanterLoader from '../loaders/banter-loader';

export default function LoadingModal({
  loader,
  message,
  showLoading,
}: {
  loader?: JSX.Element;
  message?: string;
  showLoading: boolean;
}) {
  if (!showLoading) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
      role="status"
      aria-live="polite"
    >
      <div className="mt-4 flex w-[90dvw] max-w-[600px] flex-col rounded-[20px] bg-tp-canvas p-4 shadow-lg">
        <div className="flex h-full flex-col items-center justify-center">
          {loader ? loader : <BanterLoader />}
        </div>
        <h3 className="z-[1] text-center">
          {message ?? 'Working on it. This may take a moment...'}
        </h3>
      </div>
    </div>
  );
}
