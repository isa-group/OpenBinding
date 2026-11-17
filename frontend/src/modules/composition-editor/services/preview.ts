// The live preview of the composition editor: the document as the gateway parses it (`POST /v1/compositions/parse`), drawn by
// the renderer's catalog preset as SPHERE's Pricing2Yaml editor draws its pricing beside the code. A draft is no version: its
// values are the ones it declares, and nothing about it is evaluated.

import type { CompositionView } from '../../core/api/types';
import { documentValue, type CompositionDocument } from '../../core/utils/composition/document';
import {
  compositionViewModel,
  type CompositionViewModel,
} from '../../core/utils/composition/viewModel';

/** The renderer's model of a draft document: who it is, its workflow, its binding and the values it declares. */
export function previewModel(document: CompositionDocument): CompositionViewModel {
  const composition: CompositionView = {
    id: 'draft',
    slug: document.composition,
    name: document.composition,
    kind: document.kind,
    description: '',
    organization: { id: '', name: 'Not published', slug: '' },
    visibility: 'private',
    archived: false,
    created_at: '',
    updated_at: '',
    created_by_id: null,
    latest_version: null,
    version_count: 0,
  } as unknown as CompositionView;
  const model = compositionViewModel({ composition, version: null, document, reader: 'public' });
  return {
    ...model,
    // The draft as the version it would be: its label and syntax version, nothing sealed or derived yet.
    version: {
      id: 'draft',
      label: document.version,
      ordinal: 0,
      createdAt: '',
      syntaxVersion: document.syntaxVersion,
      basedOn: null,
      forkedFrom: null,
      derivation: null,
    },
    status: { ...model.status, values: 'declared' },
    values: Object.entries(document.values ?? {}).map(([name, value]) => ({
      name,
      ...documentValue(value),
      status: 'declared' as const,
    })),
  };
}
