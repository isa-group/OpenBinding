import JSZip from 'jszip';

export interface ZipFileEntry {
  path: string;
  name: string;
  dir: boolean;
  size: number;
  date: Date;
  readText: () => Promise<string>;
  readBinary: () => Promise<Uint8Array>;
}

export interface ZipTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  children: ZipTreeNode[];
  entry?: ZipFileEntry;
}

export interface ZipArchive {
  entries: ZipFileEntry[];
  tree: ZipTreeNode;
  totalSize: number;
}

export async function isZipBinary(data: Blob | ArrayBuffer | Uint8Array): Promise<boolean> {
  try {
    let bytes: Uint8Array;
    if (data instanceof Blob) {
      const slice = await data.slice(0, 4).arrayBuffer();
      bytes = new Uint8Array(slice);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data.slice(0, 4));
    } else {
      bytes = data.subarray(0, 4);
    }
    // Standard ZIP file signature: PK\x03\x04 or PK\x05\x06 (empty zip) or PK\x07\x08 (spanned)
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
      (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
    );
  } catch {
    return false;
  }
}

export async function readZipArchive(data: Blob | ArrayBuffer | Uint8Array): Promise<ZipArchive> {
  const zip = await JSZip.loadAsync(data);
  const entries: ZipFileEntry[] = [];
  let totalSize = 0;

  zip.forEach((relativePath, zipEntry) => {
    // JSZip uses internal property _data or we can read as binary / text
    const size = (zipEntry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    totalSize += size;
    const parts = relativePath.split('/').filter(Boolean);
    const name = parts[parts.length - 1] || relativePath;

    entries.push({
      path: relativePath,
      name,
      dir: zipEntry.dir,
      size,
      date: zipEntry.date,
      readText: () => zipEntry.async('string'),
      readBinary: () => zipEntry.async('uint8array'),
    });
  });

  // Build tree structure
  const root: ZipTreeNode = {
    name: 'root',
    path: '',
    isDir: true,
    size: totalSize,
    children: [],
  };

  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const isDir = !isLast || entry.dir;

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          isDir,
          size: isLast ? entry.size : 0,
          children: [],
          entry: isLast ? entry : undefined,
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  const sortNode = (node: ZipTreeNode) => {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNode);
  };
  sortNode(root);

  return {
    entries,
    tree: root,
    totalSize,
  };
}
