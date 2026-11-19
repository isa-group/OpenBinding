// The renderer's `operations` mode: what an environment's feed serves and how it got there. SPHERE has no environments; the
// sections follow the other modes'. The mode takes the environment's data and the page's callbacks and slots only (the
// adoption history is a domain component the page mounts), so core imports no domain module.

import type { ReactNode } from 'react';
import type { EnvironmentInEffect, UpstreamView } from '../../../api/types';
import { CompositionInEffect } from '../../composition-in-effect';
import { RendererSection } from '../RendererSection';
import type { Section } from '../presets';

/** What the `operations` mode draws: the screen reads it and hands it over. */
export interface OperationsData {
  /** The version in effect; null while nothing is adopted. */
  inEffect: EnvironmentInEffect | null;
  /** The upstream view of the version in effect, for the plan each candidate comes from. */
  upstream?: UpstreamView | null;
  /** Where a version opens, by label. */
  onOpenVersion?: (label: string) => string;
  /** Adopt a version here; absent when the reader may not. */
  onAdopt?: () => void;
  /** The adoption history, mounted by the page. */
  adoptions?: ReactNode;
  /** The margin table of the version in effect, mounted by the page. */
  margins?: ReactNode;
}

export function OperationsMode({
  sections,
  operation,
}: {
  sections: readonly Section[];
  operation: OperationsData;
}) {
  const { inEffect, upstream, onOpenVersion, onAdopt, adoptions, margins } = operation;
  return (
    <>
      {sections.includes('inEffect') && (
        <RendererSection title="Composition in effect">
          {inEffect ? (
            <CompositionInEffect
              inEffect={inEffect}
              upstream={upstream}
              versionHref={onOpenVersion ? onOpenVersion(inEffect.version.label) : null}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-sm text-tp-steel">
              Nothing is adopted here yet, so the feed answers “nothing adopted”.
              {onAdopt && (
                <button
                  type="button"
                  onClick={onAdopt}
                  className="flex h-8 cursor-pointer items-center rounded-lg bg-tp-primary px-3 text-xs font-medium text-white hover:bg-tp-primary/90"
                >
                  Adopt a version…
                </button>
              )}
            </div>
          )}
          {inEffect && margins}
        </RendererSection>
      )}
      {sections.includes('adoptions') && adoptions}
    </>
  );
}
