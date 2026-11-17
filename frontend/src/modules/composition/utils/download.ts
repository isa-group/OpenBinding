// Hand a text or a blob to the browser as a file download (SPHERE's export.service `downloadYaml`, for any file).

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

export function saveText(text: string, fileName: string, type = 'application/yaml'): void {
  saveBlob(new Blob([text], { type }), fileName);
}
