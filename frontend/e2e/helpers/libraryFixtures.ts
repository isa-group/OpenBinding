// Library artifacts the gallery mock serves to the screens that still read them (cases, studies).
import type { ArtifactDraft } from '../../src/api/library';
import type { LibraryItem, LibraryVersion } from '../../src/api/libraryItems';

const OWNER_ORG_ID = 'org-isa-demo';

const DIGEST = (seed: string) => `sha256-${seed.padEnd(64, '0').slice(0, 64)}`;

export function itemOf(name: string, kind: string, displayName: string, overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: `artifact-${name}`, organization_id: OWNER_ORG_ID, namespace: 'isa-demo', name, display_name: displayName, kind, description: '', labels: {}, archived: false,
    created_at: '2026-04-01T09:00:00Z', ...overrides,
  };
}

export function versionOf(item: LibraryItem, label: string, overrides: Partial<LibraryVersion> = {}): LibraryVersion {
  const digest = DIGEST(`${item.name.replace(/[^0-9a-f]/g, '')}${label}`);
  return {
    id: `version-${item.id}-${label}`, artifact_id: item.id, ordinal: Number(label) || 1,
    ref: { namespace: item.namespace, name: item.name, version: label, versionDigest: digest },
    contentDigest: DIGEST(`c${label}`),
    manifest: { mediaType: 'application/json', contracts: [], dependencies: [], kind: item.kind },
    based_on_id: null, public: false, withdrawn: false, created_at: '2026-04-02T09:00:00Z', ...overrides,
  };
}

export function draftOf(id: string, revision: number, content: ArtifactDraft['payload']['content'], overrides: Partial<ArtifactDraft> = {}): ArtifactDraft {
  return { id, revision, payload: { content, media_type: 'application/json', contracts: [], dependencies: [] }, based_on_id: null, ...overrides };
}

const resource = (kind: string, name: string, spec: Record<string, unknown>) => ({ apiVersion: 'qos-binding/v1', kind, metadata: { name }, spec });

const candidate = (provides: string, features: Record<string, unknown>) => ({ provides, provider: { resource: 'catalog', id: 'providers' }, features });

const catalogWith = (stock: Record<string, unknown>) => {
  return resource('CandidateCatalog', 'providers-eu', {
    providers: { providers: {} },
    featureBindings: { latency_ms: { resource: 'application', id: 'latency_ms' }, cost_eur: { resource: 'application', id: 'cost_eur' }, availability: { resource: 'application', id: 'availability' } },
    candidates: {
      fastpay: candidate('service/payment', { latency_ms: 95, cost_eur: 0.034, availability: 99.9 }),
      'payco-eu': candidate('service/payment', { latency_ms: 70, cost_eur: 0.031, availability: 99.95 }),
      'stockly-1': candidate('service/stock', stock),
    },
  });
};

/** A catalog of three providers with single values only. */
export const catalogContent = () => catalogWith({ latency_ms: 45, cost_eur: 0.004, availability: 99.5 });

/** The same catalog with three qualities of `stockly-1` given as ranges. */
export const catalogRangesContent = () => catalogWith({
  latency_ms: { min: 35, max: 60 }, cost_eur: { min: null, max: 0.004 }, availability: { min: 99.5, max: null },
});

export function rulesContent() {
  return resource('ConstraintSet', 'sla-hard', {
    constraints: {
      'sla-latency': { assert: 'sum(latency_ms) <= 600', enforcement: 'hard' },
      'sla-availability': { assert: 'min(availability) >= 99', enforcement: 'hard' },
    },
  });
}

export function goalContent() {
  return resource('Optimization', 'weighted-cost-latency', {
    criteria: [{ feature: 'cost_eur', direction: 'minimize', weight: 0.6 }, { feature: 'latency_ms', direction: 'minimize', weight: 0.4 }],
    penalties: [],
  });
}

/** The empty application a new draft starts from. */
export const applicationTemplate = () => resource('Application', 'checkout-app', { tasks: {}, features: {}, workflow: {} });

export const bpmnContent = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://openbinding/bpmn">
  <bpmn:process id="Process_1" isExecutable="false" />
</bpmn:definitions>
`;
