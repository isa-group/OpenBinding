// Adapted from SPHERE frontend/src/modules/pricing-editor/services/export.service.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: `downloadYaml` names the file after the document's `composition` and `version` and never throws (a document
// without them downloads as composition.yaml); the share link is the full `#composition=` encoding only (core/utils/sphere/
// composition-fragment), with no short cached links; the LZ-string helpers live with the fragment.

import { scalarAt } from '../utils/yamlText';

/** The file name of a document: `{composition}-{version}.yaml`, or what of it the document names. */
export function yamlFileName(yaml: string): string {
  const name = scalarAt(yaml, ['composition'])?.value.trim();
  const version = scalarAt(yaml, ['version'])?.value.trim();
  const stem = [name || 'composition', version].filter(Boolean).join('-');
  return `${stem.replace(/[^\w.-]+/g, '-')}.yaml`;
}

/** Initiates the download of the document as a YAML file. */
export function downloadYaml(yaml: string): void {
  const blob = new Blob([yaml], { type: 'application/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = yamlFileName(yaml);
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  document.body.removeChild(a);
}
