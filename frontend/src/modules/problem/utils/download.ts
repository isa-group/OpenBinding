// Hand bytes to the browser as a file download (SPHERE's export.service `downloadYaml`, for any file).

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function saveBytes(bytes: ArrayBuffer | Uint8Array, fileName: string, type: string): void {
  saveBlob(new Blob([bytes as BlobPart], { type }), fileName);
}
