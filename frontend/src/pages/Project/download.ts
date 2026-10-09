/** Hand bytes to the browser as a file download. The content goes to disk; it is never put on the page. */
export function saveBytes(bytes: ArrayBuffer, fileName: string, mediaType: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
