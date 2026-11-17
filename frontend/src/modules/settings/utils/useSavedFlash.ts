// Pattern only, after the `saved` state of SPHERE frontend/src/modules/settings/components/AccountSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's two-second "Saved" as a hook, with its timer cleared when the section goes.

import { useCallback, useEffect, useRef, useState } from 'react';

/** Whether a save has just succeeded, and the call that says so for `ms` milliseconds. */
export function useSavedFlash(ms = 2000): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = useCallback(() => {
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), ms);
  }, [ms]);

  return [saved, flash];
}
