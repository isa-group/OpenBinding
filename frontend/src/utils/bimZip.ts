/**
 * Secure BIM package import and deterministic export for the browser.
 *
 * The gateway remains authoritative, but applying the same bounds here makes
 * import atomic: malformed archives never become the current workspace. BIM
 * exports use STORE, fixed DOS timestamps, canonical JSON and LF-only XML.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const BIM_PACKAGE_LIMITS = Object.freeze({
  compressedBytes: 16 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024,
  entries: 256,
  ratio: 100,
  pathDepth: 16,
});

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const STORE = 0;
const DEFLATE = 8;
const DOS_1980_01_01 = 33;
const UNIX_REGULAR_0644 = 0o100644 << 16;
const UNIX_SYMLINK = 0o120000;

export class BimPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BimPackageError';
  }
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function utf16Compare(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function utf8Compare(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function assertUnicodeScalar(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new BimPackageError('BIM JSON contains an unpaired Unicode surrogate.');
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new BimPackageError('BIM JSON contains an unpaired Unicode surrogate.');
    }
  }
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new BimPackageError('BIM JSON cannot contain a non-finite number.');
  const rendered = JSON.stringify(value);
  if (rendered === undefined) throw new BimPackageError('BIM JSON number cannot be serialized.');
  return rendered;
}

/** RFC 8785 serialization using JavaScript's normative number rendering. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string') {
    assertUnicodeScalar(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .map((key) => {
        assertUnicodeScalar(key);
        return key;
      })
      .sort(utf16Compare)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new BimPackageError(`BIM JSON contains an unsupported ${typeof value} value.`);
}

function assertNoDuplicateJsonMembers(source: string, path: string): void {
  let cursor = 0;
  const whitespace = () => {
    while (cursor < source.length) {
      const codePoint = source.charCodeAt(cursor);
      if (codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d && codePoint !== 0x20) return;
      cursor += 1;
    }
  };
  const stringToken = (): string => {
    const start = cursor;
    if (source[cursor] !== '"') throw new BimPackageError(`${path} is not valid JSON.`);
    cursor += 1;
    while (cursor < source.length) {
      const character = source[cursor++];
      if (character === '"') {
        try {
          return JSON.parse(source.slice(start, cursor));
        } catch {
          throw new BimPackageError(`${path} is not valid JSON.`);
        }
      }
      if (character === '\\') {
        if (cursor >= source.length) break;
        if (source[cursor] === 'u') cursor += 5;
        else cursor += 1;
      } else if (character.charCodeAt(0) < 0x20) {
        throw new BimPackageError(`${path} is not valid JSON.`);
      }
    }
    throw new BimPackageError(`${path} contains an unterminated JSON string.`);
  };
  const value = (): void => {
    whitespace();
    if (source[cursor] === '{') {
      cursor += 1;
      whitespace();
      const members = new Set<string>();
      if (source[cursor] === '}') { cursor += 1; return; }
      for (;;) {
        whitespace();
        const member = stringToken();
        if (members.has(member)) throw new BimPackageError(`${path} contains duplicate JSON member ${JSON.stringify(member)}.`);
        members.add(member);
        whitespace();
        if (source[cursor++] !== ':') throw new BimPackageError(`${path} is not valid JSON.`);
        value();
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === '}') return;
        if (delimiter !== ',') throw new BimPackageError(`${path} is not valid JSON.`);
      }
    }
    if (source[cursor] === '[') {
      cursor += 1;
      whitespace();
      if (source[cursor] === ']') { cursor += 1; return; }
      for (;;) {
        value();
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === ']') return;
        if (delimiter !== ',') throw new BimPackageError(`${path} is not valid JSON.`);
      }
    }
    if (source[cursor] === '"') { stringToken(); return; }
    const primitive = source.slice(cursor).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!primitive) throw new BimPackageError(`${path} is not valid JSON.`);
    cursor += primitive.length;
  };
  value();
  whitespace();
  if (cursor !== source.length) throw new BimPackageError(`${path} has trailing JSON content.`);
}

function strictJson(source: string, path: string): unknown {
  assertNoDuplicateJsonMembers(source, path);
  try {
    return JSON.parse(source);
  } catch {
    throw new BimPackageError(`${path} is not valid JSON.`);
  }
}

function canonicalFile(path: string, source: string): string {
  if (path.toLowerCase().endsWith('.json')) {
    return canonicalJson(strictJson(source, path));
  }
  if (path.toLowerCase().endsWith('.xml') || path.toLowerCase().endsWith('.bpmn')) {
    return source.replace(/\r\n?/g, '\n');
  }
  return source;
}

function caseFold(value: string): string {
  // ECMAScript has no full Unicode case-fold primitive. NFKC + lower-case
  // covers the filesystem collision classes relevant to package paths; the
  // gateway performs the authoritative Unicode case-fold check as well.
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

function normalizePath(supplied: string): string {
  if (!supplied || supplied.includes('\0')) throw new BimPackageError('A BIM package path is empty or contains NUL.');
  if (supplied.length > 4096) throw new BimPackageError(`BIM package path is too long: ${supplied}`);
  if (supplied.includes('\\') || supplied.startsWith('/') || supplied.startsWith('~') || /^[A-Za-z]:[\\/]/.test(supplied)) {
    throw new BimPackageError(`Unsafe BIM package path: ${supplied}`);
  }
  const normalized = supplied.normalize('NFC');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new BimPackageError(`Traversal or empty component in BIM package path: ${supplied}`);
  }
  if (parts.length > BIM_PACKAGE_LIMITS.pathDepth) {
    throw new BimPackageError(`BIM package path exceeds depth ${BIM_PACKAGE_LIMITS.pathDepth}: ${supplied}`);
  }
  return normalized;
}

function validatedTextFiles(files: Record<string, string>): Record<string, string> {
  const entries = Object.entries(files);
  if (entries.length > BIM_PACKAGE_LIMITS.entries) {
    throw new BimPackageError(`BIM package contains more than ${BIM_PACKAGE_LIMITS.entries} entries.`);
  }
  const result: Record<string, string> = {};
  const folded = new Set<string>();
  let total = 0;
  for (const [suppliedPath, source] of entries) {
    if (typeof source !== 'string') throw new BimPackageError(`BIM package entry is not UTF-8 text: ${suppliedPath}`);
    const path = normalizePath(suppliedPath);
    const key = caseFold(path);
    if (Object.hasOwn(result, path) || folded.has(key)) throw new BimPackageError(`Duplicate BIM package path: ${path}`);
    folded.add(key);
    const size = encoder.encode(source).length;
    if (size > BIM_PACKAGE_LIMITS.entryBytes) throw new BimPackageError(`BIM package entry is too large: ${path}`);
    total += size;
    if (total > BIM_PACKAGE_LIMITS.expandedBytes) throw new BimPackageError('Expanded BIM package is too large.');
    result[path] = source;
  }
  if (!Object.hasOwn(result, 'instance.json')) throw new BimPackageError('BIM package does not contain instance.json.');
  return result;
}

/** Build a byte-for-byte deterministic ZIP from a BIM virtual filesystem. */
export function zipStore(sourceFiles: Record<string, string>): Uint8Array {
  const files = validatedTextFiles(sourceFiles);
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const path of Object.keys(files).sort(utf8Compare)) {
    const nameBytes = encoder.encode(path);
    const data = encoder.encode(canonicalFile(path, files[path]));
    const flags = nameBytes.length === path.length ? 0 : UTF8_FLAG;
    const checksum = crc32(data);
    const header = join(
      u32(LOCAL_SIGNATURE), u16(20), u16(flags), u16(STORE), u16(0), u16(DOS_1980_01_01),
      u32(checksum), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
    );
    local.push(header, data);
    central.push(join(
      u32(CENTRAL_SIGNATURE), u16((3 << 8) | 20), u16(20), u16(flags), u16(STORE), u16(0),
      u16(DOS_1980_01_01), u32(checksum), u32(data.length), u32(data.length), u16(nameBytes.length),
      u16(0), u16(0), u16(0), u16(0), u32(UNIX_REGULAR_0644), u32(offset), nameBytes,
    ));
    offset += header.length + data.length;
  }
  const localBytes = join(...local);
  const centralBytes = join(...central);
  const archive = join(
    localBytes,
    centralBytes,
    u32(EOCD_SIGNATURE), u16(0), u16(0), u16(Object.keys(files).length), u16(Object.keys(files).length),
    u32(centralBytes.length), u32(localBytes.length), u16(0),
  );
  if (archive.length > BIM_PACKAGE_LIMITS.compressedBytes) throw new BimPackageError('BIM package is too large.');
  return archive;
}

function findEocd(bytes: Uint8Array, view: DataView): number {
  for (let index = bytes.length - 22; index >= 0 && index >= bytes.length - 65_557; index -= 1) {
    if (view.getUint32(index, true) === EOCD_SIGNATURE) return index;
  }
  throw new BimPackageError('The selected file is not a complete ZIP archive.');
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new BimPackageError('This browser cannot import compressed ZIP entries; export a deterministic STORE .bim.zip.');
  }
  try {
    const copy = data.slice();
    const input = new Blob([copy.buffer as ArrayBuffer]).stream();
    const output = input.pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat));
    return new Uint8Array(await new Response(output).arrayBuffer());
  } catch (error) {
    throw new BimPackageError(`A compressed BIM package entry could not be expanded: ${String(error)}`);
  }
}

interface CentralEntry {
  path: string;
  flags: number;
  method: number;
  checksum: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Read a bounded STORE/DEFLATE ZIP without extracting it to a filesystem. */
export async function unzipPackage(buffer: ArrayBuffer): Promise<Record<string, string>> {
  if (buffer.byteLength > BIM_PACKAGE_LIMITS.compressedBytes) throw new BimPackageError('Compressed BIM package is too large.');
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEocd(bytes, view);
  const eocdCommentLength = view.getUint16(eocd + 20, true);
  if (eocd + 22 + eocdCommentLength !== bytes.length) throw new BimPackageError('BIM ZIP has trailing or truncated data.');
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  let cursor = view.getUint32(eocd + 16, true);
  const centralStart = cursor;
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== count) throw new BimPackageError('Multi-disk BIM ZIP packages are not supported.');
  if (count > BIM_PACKAGE_LIMITS.entries) throw new BimPackageError(`BIM package contains more than ${BIM_PACKAGE_LIMITS.entries} entries.`);
  if (cursor + centralSize > eocd) throw new BimPackageError('BIM ZIP central directory is out of bounds.');

  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  const folded = new Set<string>();
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new BimPackageError('Invalid BIM ZIP central directory.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const checksum = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new BimPackageError('Truncated BIM ZIP central entry.');
    if (flags & ENCRYPTED_FLAG) throw new BimPackageError('Encrypted BIM ZIP entries are forbidden.');
    if (method !== STORE && method !== DEFLATE) throw new BimPackageError(`Unsupported BIM ZIP compression method: ${method}`);
    if (size > BIM_PACKAGE_LIMITS.entryBytes) throw new BimPackageError('A BIM package entry is too large.');
    expanded += size;
    if (expanded > BIM_PACKAGE_LIMITS.expandedBytes) throw new BimPackageError('Expanded BIM package is too large.');
    if (compressedSize === 0 && size !== 0) throw new BimPackageError('Invalid zero-sized compressed BIM entry.');
    if (compressedSize > 0 && size / compressedSize > BIM_PACKAGE_LIMITS.ratio) throw new BimPackageError('BIM ZIP compression ratio is too high.');
    if (((externalAttributes >>> 16) & 0o170000) === UNIX_SYMLINK) throw new BimPackageError('BIM ZIP symlinks are forbidden.');
    let suppliedPath: string;
    try {
      suppliedPath = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    } catch {
      throw new BimPackageError('A BIM ZIP path is not valid UTF-8.');
    }
    const path = normalizePath(suppliedPath);
    const foldedPath = caseFold(path);
    if (names.has(path) || folded.has(foldedPath)) throw new BimPackageError(`Duplicate BIM package path: ${path}`);
    names.add(path);
    folded.add(foldedPath);
    entries.push({ path, flags, method, checksum, compressedSize, size, localOffset });
    cursor = end;
  }
  if (cursor !== centralStart + centralSize) throw new BimPackageError('BIM ZIP central directory size is inconsistent.');

  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.localOffset + 30 > bytes.length || view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
      throw new BimPackageError(`Invalid BIM ZIP local header for ${entry.path}.`);
    }
    const localFlags = view.getUint16(entry.localOffset + 6, true);
    const localMethod = view.getUint16(entry.localOffset + 8, true);
    const localChecksum = view.getUint32(entry.localOffset + 14, true);
    const localCompressedSize = view.getUint32(entry.localOffset + 18, true);
    const localSize = view.getUint32(entry.localOffset + 22, true);
    const localNameLength = view.getUint16(entry.localOffset + 26, true);
    const localExtraLength = view.getUint16(entry.localOffset + 28, true);
    let localPath: string;
    try {
      localPath = normalizePath(decoder.decode(bytes.slice(entry.localOffset + 30, entry.localOffset + 30 + localNameLength)));
    } catch {
      throw new BimPackageError(`Invalid BIM ZIP local filename for ${entry.path}.`);
    }
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length || localPath !== entry.path || localMethod !== entry.method || (localFlags & ~DATA_DESCRIPTOR_FLAG) !== (entry.flags & ~DATA_DESCRIPTOR_FLAG)) {
      throw new BimPackageError(`Inconsistent BIM ZIP local header for ${entry.path}.`);
    }
    if (!(localFlags & DATA_DESCRIPTOR_FLAG) && (localChecksum !== entry.checksum || localCompressedSize !== entry.compressedSize || localSize !== entry.size)) {
      throw new BimPackageError(`Inconsistent BIM ZIP local sizes or checksum for ${entry.path}.`);
    }
    const compressed = bytes.slice(dataStart, dataEnd);
    const content = entry.method === STORE ? compressed : await inflateRaw(compressed);
    if (content.length !== entry.size) throw new BimPackageError(`Truncated BIM package entry: ${entry.path}`);
    if (crc32(content) !== entry.checksum) throw new BimPackageError(`CRC mismatch in BIM package entry: ${entry.path}`);
    try {
      result[entry.path] = decoder.decode(content);
    } catch {
      throw new BimPackageError(`BIM package entry is not valid UTF-8 text: ${entry.path}`);
    }
  }
  return validatedTextFiles(result);
}

/** Canonicalize a workspace before its deterministic ZIP package is built. */
export function packageFiles(files: Record<string, string>): Record<string, string> {
  const validated = validatedTextFiles(files);
  return Object.fromEntries(Object.entries(validated).map(([path, source]) => [path, canonicalFile(path, source)]));
}
