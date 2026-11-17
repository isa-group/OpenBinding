import { describe, expect, it } from 'vitest';
import { unzipPackage } from '../../../utils/bimZip';
import { DEFAULT_FILES } from '../utils/documents';
import { packageArchive, packageFileName } from './export';

describe('the package export', () => {
  it('names the archive after the Instance', () => {
    expect(packageFileName(DEFAULT_FILES)).toBe('hello-bim.bim.zip');
    expect(packageFileName({ 'instance.json': '{' })).toBe('package.bim.zip');
  });

  it('writes the files as a .bim.zip the editor can open again', async () => {
    const bytes = packageArchive(DEFAULT_FILES);
    const files = await unzipPackage(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );
    expect(Object.keys(files).sort()).toEqual(Object.keys(DEFAULT_FILES).sort());
  });
});
