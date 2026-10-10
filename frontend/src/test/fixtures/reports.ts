import type { Publication, Report } from '../../api/platform';
import { RUN_ID, digestOf } from './studies';

/** The reports of the QoS Benchmarks project: a frozen edition that is published, a draft, and an older-shaped draft. */
export const EDITION = digestOf('e');
export const MATRIX = digestOf('d');

export const PROVENANCE = {
  study: { runId: RUN_ID, matrixDigest: MATRIX },
  datasets: [{ reference: 'checkout-flow@2', digest: digestOf('a') }],
  software: [{ name: 'bim-reference-evaluator', version: '1.0.0', digest: digestOf('b') }],
  bimVersion: 'bim/v1',
  engineRevisions: [digestOf('c')],
  parameters: {},
};

export function reportOf(slug: string, state: Report['state'], over: Partial<Report> = {}): Report {
  return {
    artifact_id: `artifact-${slug}`, version_id: state === 'frozen' ? `version-${slug}` : null, draft_id: state === 'draft' ? `draft-${slug}` : null,
    draft_revision: state === 'draft' ? 3 : null, id: `report-${slug}`, project_id: 'project-qos-benchmarks', study_run_id: null, slug, title: slug,
    document: {}, digest: state === 'frozen' ? EDITION : '', state, created_at: '2026-09-25T09:00:00Z', ...over,
  };
}

export const FROZEN = reportOf('engine-comparison', 'frozen', {
  title: 'Engine comparison at checkout', study_run_id: RUN_ID,
  document: {
    blocks: [
      { type: 'heading', text: 'Engine comparison at checkout' },
      { type: 'text', text: 'Two engines, two seeds, two revisions of the checkout case.' },
      { type: 'evidence', text: 'Engines × seeds · run #1', runId: RUN_ID },
    ],
    provenance: PROVENANCE,
  },
});

export const DRAFT = reportOf('draft-placement', 'draft', {
  title: 'Draft: placement', document: { blocks: [{ type: 'heading', text: 'Draft: placement' }, { type: 'text', text: 'Pools and latencies on the edge.' }], provenance: {} },
});

export const LEGACY = reportOf('older-notes', 'draft', {
  title: 'Older notes', draft_revision: 1,
  document: { summary: 'Initial notes', findings: ['Evolutionary is cheaper but slower.'], provenance: {} },
});

export function publicationOf(report: Report, over: Partial<Publication> = {}): Publication {
  return {
    id: `pub-${report.slug}`, project_id: report.project_id, report_id: report.id, version_id: report.version_id ?? 'version-none', withdrawn: false, slug: 'checkout-comparison',
    citation: { title: 'Engine comparison at checkout', authors: ['Alex Rivera'], year: 2026, venue: 'ISA Demo Group / QoS Benchmarks' },
    published_at: '2026-09-25T10:00:00Z', ...over,
  };
}
