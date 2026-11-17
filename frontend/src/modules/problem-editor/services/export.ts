// Adapted from SPHERE frontend/src/modules/pricing-editor/services/export.service.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a BIM package instead of a YAML text: the files are written as the `.bim.zip` the gateway reads (the canonical
// form the check sends, or the files as they are when they are not a package yet), named after the Instance's
// `metadata.name`; nothing is sent anywhere.

import { packageFiles, zipStore } from '../../../utils/bimZip';
import { parseJson, type WorkspaceFiles } from '../utils/documents';

/** The file name of a package: `{metadata.name}.bim.zip`, or `package.bim.zip`. */
export function packageFileName(files: WorkspaceFiles): string {
  const root = parseJson(files['instance.json']);
  const name = typeof root?.metadata?.name === 'string' ? root.metadata.name.trim() : '';
  return `${(name || 'package').replace(/[^\w.-]+/g, '-')}.bim.zip`;
}

/** The bytes of the package's archive: its canonical files, or the files as written when they are not a valid package yet. */
export function packageArchive(files: WorkspaceFiles): Uint8Array {
  try {
    return zipStore(packageFiles(files));
  } catch {
    return zipStore(files);
  }
}

/** Initiates the download of the package as a `.bim.zip`. */
export function downloadPackage(files: WorkspaceFiles): void {
  const archive = packageArchive(files);
  const blob = new Blob([archive as unknown as BlobPart], { type: 'application/vnd.bim+zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = packageFileName(files);
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  document.body.removeChild(a);
}
