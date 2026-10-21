import { useId, useState } from 'react';
import { Plus } from 'lucide-react';
import { Action } from '../../components/ui/Action';
import { libraryItemsApi, type LibraryItem, type LibraryVersion } from '../../api/libraryItems';
import { useResource } from '../../utils/useResource';
import { kindLabel, newestFirst, PUBLICATION_LABELS, publicationOf } from './libraryModel';
import { useVersions } from './useLibrary';

interface VersionPickerProps {
  orgSlug: string;
  title: string;
  /** Leaves out the item being edited: a collection can't contain itself. */
  exceptItem?: string;
  onPick: (item: LibraryItem, version: LibraryVersion) => void;
  disabled?: boolean;
}

/** Picks one exact sealed version from the library (withdrawn ones are left out): item first, then its version. */
export function VersionPicker({ orgSlug, title, exceptItem, onPick, disabled }: VersionPickerProps) {
  const id = useId();
  const [itemId, setItemId] = useState('');
  const [versionId, setVersionId] = useState('');
  const items = useResource<LibraryItem[]>(`picker-items:${orgSlug}`, () => libraryItemsApi.list(orgSlug, true));
  const versions = useVersions(itemId || undefined);
  const item = items.data?.find((candidate) => candidate.id === itemId);
  const usable = newestFirst(versions.data ?? []).filter((version) => !version.withdrawn);
  const version = usable.find((candidate) => candidate.id === versionId);

  return (
    <fieldset className="lib-picker" disabled={disabled}>
      <legend>{title}</legend>
      {items.status === 'error' && <p className="lib-error-text" role="alert">The library couldn’t be read, so there is nothing to pick from.</p>}
      <div className="ui-field">
        <label htmlFor={`${id}-item`}>Library item</label>
        <select id={`${id}-item`} value={itemId} onChange={(event) => { setItemId(event.target.value); setVersionId(''); }}>
          <option value="">Choose an item</option>
          {(items.data ?? []).filter((candidate) => candidate.id !== exceptItem).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.display_name} · {kindLabel(candidate.kind)}</option>
          ))}
        </select>
      </div>
      <div className="ui-field">
        <label htmlFor={`${id}-version`}>Exact version</label>
        <select id={`${id}-version`} value={versionId} disabled={!itemId || versions.status === 'loading'} onChange={(event) => setVersionId(event.target.value)}>
          <option value="">{itemId && versions.status === 'ready' && usable.length === 0 ? 'No sealed version yet' : 'Choose a version'}</option>
          {usable.map((candidate) => <option key={candidate.id} value={candidate.id}>Version {candidate.ref.version} · {PUBLICATION_LABELS[publicationOf(candidate)]}</option>)}
        </select>
      </div>
      <Action variant="secondary" size="sm" disabled={!item || !version} onClick={() => { if (item && version) { onPick(item, version); setVersionId(''); } }}>
        <Plus aria-hidden="true" className="org-inline-icon" />Add version
      </Action>
    </fieldset>
  );
}
