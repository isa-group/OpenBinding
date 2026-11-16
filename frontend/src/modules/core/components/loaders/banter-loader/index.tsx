// Copied verbatim from SPHERE frontend/src/modules/core/components/loaders/banter-loader/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.

import React from 'react';

const BanterLoader: React.FC = () => {
  return (
    <div className="-mt-9 -ml-9 grid h-18 w-18 grid-cols-3 gap-1.5">
      {Array.from({ length: 9 }).map((_, index) => {
        return (
          <div
            key={index}
            className="banter-box h-[20px] w-[20px] animate-banter-box bg-tp-primary"
          />
        );
      })}
    </div>
  );
};

export default BanterLoader;
