import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import ArtifactLibraryPage from './ArtifactLibraryPage';

const fixtures = vi.hoisted(() => {
  const ref = { namespace: 'org', name: 'dataset', version: '1', versionDigest: `sha256-${'a'.repeat(64)}` };
  const artifact = { id: 'collection', organization_id: 'org', kind: 'Collection', namespace: 'org', name: 'collection', display_name: 'Collection', description: '', labels: {}, archived: false };
  const draft = { id: 'draft', revision: 1, based_on_id: null, payload: { content: { apiVersion: 'openbinding/collection/v1', members: [] }, media_type: 'application/json', contracts: [], dependencies: [] } };
  return { ref, artifact, draft, context: { organization: { id: 'org', slug: 'team', effective_role: 'OWNER' }, project: null },
    api: { list: vi.fn(), versions: vi.fn(), drafts: vi.fn(), editDraft: vi.fn() } };
});
vi.mock('../../api/library', () => ({ libraryApi: fixtures.api }));
vi.mock('react-router-dom', async () => ({ ...await vi.importActual('react-router-dom'), useOutletContext: () => fixtures.context }));
vi.mock('../../components/CodeEditor/CodeEditor', () => ({ CodeEditor: ({ value }: { value: string }) => <pre>{value}</pre> }));
vi.mock('../../components/Artifacts/ArtifactVersionPicker', () => ({ ArtifactVersionPicker: ({ onSelect }: { onSelect: (artifact: object, version: object) => void }) =>
  <button onClick={() => onSelect({}, { ref: fixtures.ref })}>Choose dataset v1</button> }));

it('adds a collection member and its exact dependency together without duplicates', async () => {
  fixtures.api.list.mockResolvedValue([fixtures.artifact]);
  fixtures.api.versions.mockResolvedValue([]);
  fixtures.api.drafts.mockResolvedValue([fixtures.draft]);
  fixtures.api.editDraft.mockResolvedValue({ id: 'draft', revision: 2 });
  render(<MemoryRouter initialEntries={['/?artifact=collection']}><ArtifactLibraryPage /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('Editable draft'), { target: { value: 'draft' } });
  fireEvent.click(screen.getByText('Choose dataset v1'));
  fireEvent.click(screen.getByText('Choose dataset v1'));
  fireEvent.click(screen.getByText('Save draft'));
  await waitFor(() => expect(fixtures.api.editDraft).toHaveBeenCalledWith('collection', expect.anything(), {
    content: { apiVersion: 'openbinding/collection/v1', members: [fixtures.ref] },
    media_type: 'application/json', contracts: [], dependencies: [fixtures.ref],
  }));
});
