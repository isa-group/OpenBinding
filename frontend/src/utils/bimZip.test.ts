import { describe, expect, it } from 'vitest';
import { BimPackageError, canonicalJson, unzipPackage, zipStore } from './bimZip';

const files = {
  'instance.json': '{\n  "spec": {"profile": "qos-binding/v1", "resources": {"application": {"workflow": "workflow.bpmn"}}}, "metadata": {"name": "x"}, "kind": "Instance", "apiVersion": "bim/v1"\n}',
  'workflow.bpmn': '<definitions>\r\n</definitions>\r\n',
};

describe('BIM canonical JSON', () => {
  it('uses RFC 8785 UTF-16 property ordering and ECMAScript numbers', () => {
    expect(canonicalJson({ '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew', '1': 'One', '\ud83d\ude00': 'Emoji', '\u0080': 'Control', '\u00f6': 'Latin' }))
      .toBe('{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji","\ufb33":"Hebrew"}');
    expect(canonicalJson([Number('333333333.33333329'), 1e30, 4.5, 0.002, 1e-27])).toBe('[333333333.3333333,1e+30,4.5,0.002,1e-27]');
  });

  it('rejects non-finite numeric input', () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(BimPackageError);
  });

  it('rejects duplicate JSON members instead of silently overwriting them', () => {
    expect(() => zipStore({ 'instance.json': '{"kind":"Instance","kind":"Other"}' }))
      .toThrow(/duplicate JSON member/);
  });
});

describe('deterministic BIM ZIP', () => {
  it('is byte-for-byte stable and round-trips canonical text', async () => {
    const first = zipStore(files);
    const second = zipStore({ 'workflow.bpmn': files['workflow.bpmn'], 'instance.json': files['instance.json'] });
    expect(first).toEqual(second);
    const roundTrip = await unzipPackage(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength) as ArrayBuffer);
    expect(roundTrip['instance.json']).toBe('{"apiVersion":"bim/v1","kind":"Instance","metadata":{"name":"x"},"spec":{"profile":"qos-binding/v1","resources":{"application":{"workflow":"workflow.bpmn"}}}}');
    expect(roundTrip['workflow.bpmn']).toBe('<definitions>\n</definitions>\n');
  });

  it('rejects unsafe and case-fold-colliding paths', () => {
    expect(() => zipStore({ ...files, '../secret.json': '{}' })).toThrow(BimPackageError);
    expect(() => zipStore({ ...files, 'A.json': '{}', 'a.json': '{}' })).toThrow(BimPackageError);
  });

  it('rejects local/central filename disagreement', async () => {
    const archive = zipStore(files);
    const tampered = archive.slice();
    // The first local filename begins at byte 30. Keep its length, but make it
    // differ from the central-directory name.
    tampered[30] = 'I'.charCodeAt(0);
    await expect(unzipPackage(tampered.buffer as ArrayBuffer)).rejects.toThrow(/local header|local filename/i);
  });

  it('rejects corrupt entry contents through CRC validation', async () => {
    const archive = zipStore(files);
    const tampered = archive.slice();
    const nameLength = new DataView(tampered.buffer).getUint16(26, true);
    tampered[30 + nameLength] ^= 1;
    await expect(unzipPackage(tampered.buffer as ArrayBuffer)).rejects.toThrow(/CRC/i);
  });
});
