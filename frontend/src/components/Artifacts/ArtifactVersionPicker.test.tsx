import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { libraryApi, type Artifact, type ArtifactVersion } from '../../api/library';
import { ArtifactVersionPicker } from './ArtifactVersionPicker';

vi.mock('../../api/library', () => ({ libraryApi: { list: vi.fn(), versions: vi.fn() } }));

const artifact = (id: string, kind: string): Artifact => ({
  id, organization_id: 'org-1', namespace: 'isa', name: id, display_name: `Artifact ${id}`, kind, description: '', labels: {}, archived: false,
});

const version = (id: string, artifactId: string, withdrawn = false): ArtifactVersion => ({
  id, artifact_id: artifactId, ordinal: 1, ref: { namespace: 'isa', name: artifactId, version: `1.0.${id}`, versionDigest: `sha256:${id}` },
  contentDigest: 'sha256:0123456789abcdef0123456789abcdef', manifest: { mediaType: 'application/json', contracts: [], dependencies: [] },
  based_on_id: null, public: false, withdrawn,
});

describe('ArtifactVersionPicker', () => {
  beforeEach(() => {
    vi.mocked(libraryApi.list).mockResolvedValue([artifact('a1', 'ExecutionConfiguration'), artifact('a2', 'Other')]);
    vi.mocked(libraryApi.versions).mockImplementation(async (id) => [version('v1', id), version('v2', id, true)]);
  });

  it('lists the artifacts of the kind, then the sealed versions of the one chosen, never a withdrawn one', async () => {
    const onSelect = vi.fn();
    render(<ArtifactVersionPicker org="isa" kind="ExecutionConfiguration" onSelect={onSelect} />);

    const artifactSelect = await screen.findByLabelText('Artifact');
    await waitFor(() => expect(screen.getByRole('option', { name: /Artifact a1/ })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /Artifact a2/ })).toBeNull();
    expect(screen.getByLabelText('Version')).toBeDisabled();

    fireEvent.change(artifactSelect, { target: { value: 'a1' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /1\.0\.v1/ })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /1\.0\.v2/ })).toBeNull();

    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v1' } });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), expect.objectContaining({ id: 'v1' }));
  });

  it('starts on the artifact and version it is given, and follows a different one', async () => {
    const { rerender } = render(<ArtifactVersionPicker org="isa" artifactId="a1" versionId="v1" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /1\.0\.v1/ })).toBeInTheDocument());
    expect(screen.getByLabelText('Artifact')).toHaveValue('a1');
    expect(screen.getByLabelText('Version')).toHaveValue('v1');

    rerender(<ArtifactVersionPicker org="isa" artifactId="a2" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Artifact')).toHaveValue('a2'));
    expect(screen.getByLabelText('Version')).toHaveValue('');
  });

  it('shows the refusal of the library', async () => {
    vi.mocked(libraryApi.list).mockRejectedValue(new Error('library unavailable'));
    render(<ArtifactVersionPicker org="isa" onSelect={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('library unavailable');
  });
});
