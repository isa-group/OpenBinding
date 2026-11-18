import type { Located } from '../../../core/diagnostics/located';
import type { ProblemFacts } from '../../../core/api/types';
import type { SphereExpandView, SphereFinding, SphereVersionView } from '../../api/sphereApi';
import type { WizardForm } from './recipe';
import type { VersionSummary } from './summary';

/** The address keys the wizard keeps its place in. */
export const SPHERE_PARAMS = ['sphereStep', 'sphere', 'sphereVersion', 'sphereUpdate'] as const;

/** The wizard's six steps, in SPHERE's order (plan §6): what the address's `sphereStep` names. */
export const STEPS = ['pricing', 'version', 'plans', 'mapping', 'preview', 'generate'] as const;
export type Step = (typeof STEPS)[number];

export const STEP_LABELS: Readonly<Record<Step, string>> = {
  pricing: 'Pricing',
  version: 'Version',
  plans: 'Task and plans',
  mapping: 'Mapping',
  preview: 'Preview',
  generate: 'Generate',
};

export const isStep = (value: string | null): value is Step =>
  (STEPS as readonly string[]).includes(value ?? '');

/** The pricing being added: chosen in step 1 (its family), then its version in step 2. */
export interface Draft {
  pricingId: string;
  name: string;
  owner: string | null;
  registry: string | null;
  versionId: string | null;
}

/** A version the wizard read: the gateway's view (its snapshot and summary) and the snapshot's YAML. */
export interface LoadedVersion {
  view: SphereVersionView;
  summary: VersionSummary;
  yaml: string;
}

/** What the wizard keeps across a reload of the page (sessionStorage; nothing else depends on it). */
export interface Kept {
  form: WizardForm;
  draft: Draft | null;
}

/** The problem the wizard adds to: its latest version and that version's facts (tasks and features). */
export interface Base {
  revision: number;
  facts: ProblemFacts | null;
}

/** A finding of the preview as the problems panel reads it. */
export const locatedOf = (finding: SphereFinding): Located => ({
  code: finding.code,
  message: finding.message,
  severity: finding.severity,
  where: { kind: 'package' },
  pointer: finding.at || undefined,
});

const KEPT = 'openbinding.sphere-wizard';

export function readKept(scope: string): Kept | null {
  try {
    const raw = window.sessionStorage.getItem(`${KEPT}:${scope}`);
    return raw ? (JSON.parse(raw) as Kept) : null;
  } catch {
    return null;
  }
}

export function writeKept(scope: string, kept: Kept | null): void {
  try {
    if (kept) window.sessionStorage.setItem(`${KEPT}:${scope}`, JSON.stringify(kept));
    else window.sessionStorage.removeItem(`${KEPT}:${scope}`);
  } catch {
    // A private window or full storage: the wizard keeps its state until the page is left.
  }
}

/** A provider whose pinned version the update changes: one plan of it in both versions, for the change review. */
export interface PlanReview {
  provider: string;
  title: string;
  plan: string;
  addOns: string[];
  beforeLabel: string;
  afterLabel: string;
  before: string;
  after: string;
}

/** A value the preview needs set by hand: the candidate, the feature and the manual key it is written under. */
export interface ManualCell {
  candidate: string;
  target: string;
  key: string;
  message: string;
}

/** The values the generator could not read (`sphere_property_unmapped` on a candidate), to be set by hand. */
export function manualCells(expanded: SphereExpandView): ManualCell[] {
  const byKey = new Map(expanded.candidates.map(candidate => [candidate.key, candidate]));
  return expanded.diagnostics
    .filter(
      (finding: SphereFinding) =>
        finding.code === 'sphere_property_unmapped' && typeof finding.target === 'string'
    )
    .map(finding => {
      const candidate = byKey.get(finding.at);
      const id = finding.at.split('/').pop() ?? finding.at;
      const provider = candidate?.provider ?? id.split('.')[1] ?? '*';
      return {
        candidate: finding.at,
        target: String(finding.target),
        key: candidate?.plan ? `${provider}.${candidate.plan}` : provider,
        message: finding.message,
      };
    });
}
