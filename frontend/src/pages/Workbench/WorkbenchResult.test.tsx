import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { zipStore } from '../../utils/bimZip';
import { StructurePanel } from './WorkbenchResult';
import { readPackageModel } from './packageModel';
import { packageFilesNamed } from './workbenchTestKit';

const FULL = `sha256-${'ab'.repeat(32)}`;

async function modelWithRegisteredResource() {
  const files = packageFilesNamed('checkout');
  const instance = JSON.parse(files['instance.json']);
  instance.spec.resources.extra = { shared: { namespace: 'isa-demo', name: 'shared-catalog', version: '2.0.0', digest: FULL } };
  files['instance.json'] = JSON.stringify(instance);
  const bytes = zipStore(files);
  return readPackageModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

describe('the package structure panel', () => {
  it('names files and copies their digests without ever showing one', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const model = await modelWithRegisteredResource();
    render(<StructurePanel model={model} valid fileDigests={{ 'instance.json': FULL, 'application.json': `sha256-${'cd'.repeat(32)}` }} problemsByFile={{}} onShowProblems={() => undefined} />);

    const copy = screen.getByRole('button', { name: 'Copy digest of instance.json' });
    expect(copy).toHaveTextContent('Copy digest');
    expect(screen.getByText(/isa-demo\/shared-catalog@2\.0\.0/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('sha256-');
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{12}/);

    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FULL));
  });

  it('offers no copy button for a file without a digest', async () => {
    const model = await modelWithRegisteredResource();
    render(<StructurePanel model={model} valid fileDigests={{}} problemsByFile={{}} onShowProblems={() => undefined} />);
    expect(screen.queryByRole('button', { name: /Copy digest of/ })).not.toBeInTheDocument();
  });
});
