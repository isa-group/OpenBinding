import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../api/client';
import type { CompositionView } from '../../../shared/api/types';
import type { CompositionAccess } from '../useRouteComposition';
import { PUBLISH_CONFIRMATION, SettingsTab } from './SettingsTab';

const api = vi.hoisted(() => ({ update: vi.fn(), remove: vi.fn() }));
vi.mock('../../../entities/composition/api', () => ({ compositionsApi: api }));

const composition: CompositionView = {
  id: 'composition-fleet', slug: 'fleet-routing', name: 'Fleet routing', description: 'Routes the fleet.', kind: 'workflow',
  archived: false, visibility: 'private', organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
  created_by_id: null, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', version_count: 3,
  latest_version: { id: 'v3', ordinal: 3, label: '1.2.0', values_status: 'verified', created_at: '2026-10-01T00:00:00Z' },
};

const ADMIN: CompositionAccess = { role: 'ADMIN', canCreate: true, canAdminister: true };
const MEMBER: CompositionAccess = { role: 'MEMBER', canCreate: true, canAdminister: false };
const VIEWER: CompositionAccess = { role: 'VIEWER', canCreate: false, canAdminister: false };

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname}{JSON.stringify(where.state ?? null)}</output>;
}

function renderTab(access: CompositionAccess, shown: CompositionView = composition) {
  const onChanged = vi.fn();
  render(
    <MemoryRouter initialEntries={['/app/isa-demo/compositions/fleet-routing/settings']}>
      <Routes>
        <Route
          path="*"
          element={(
            <>
              <SettingsTab org="isa-demo" organizationName="ISA Demo Group" composition={shown} etag='W/"7"' access={access} onChanged={onChanged} />
              <Where />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onChanged };
}

describe('Settings tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.update.mockResolvedValue({ value: composition, etag: 'W/"8"' });
    api.remove.mockResolvedValue(undefined);
  });

  it('gives an ADMIN every setting: details, archived, visibility and delete', () => {
    renderTab(ADMIN);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Fleet routing');
    expect(screen.getByRole('switch', { name: 'Archived' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Only the members of ISA Demo Group read it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make public' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete composition' })).toBeInTheDocument();
  });

  it('lets a MEMBER edit and archive, but not change who reads it nor delete it', () => {
    renderTab(MEMBER);

    expect(screen.getByRole('textbox', { name: 'Name' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Archived' })).toBeEnabled();
    expect(screen.getByText('Changing who reads it needs ADMIN.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make (public|private)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete composition' })).toBeNull();
  });

  it('changes nothing for a VIEWER, and says why', () => {
    renderTab(VIEWER);

    expect(screen.getByText('Changing a composition’s settings needs MEMBER in ISA Demo Group; you’re VIEWER.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('saves the name and description on the revision the page read (If-Match), then reads the composition again', async () => {
    const { onChanged } = renderTab(MEMBER);

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Fleet routing EU ' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Description/ }), { target: { value: 'Routes the EU fleet.' } });
    fireEvent.click(save);

    await waitFor(() => expect(api.update).toHaveBeenCalledWith('isa-demo', 'fleet-routing', { name: 'Fleet routing EU', description: 'Routes the EU fleet.' }, 'W/"7"'));
    expect(await screen.findByText('Name and description saved.')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('reads the composition again after a 412 and says so, keeping what was typed', async () => {
    api.update.mockRejectedValue(Object.assign(new HttpError(412, 'Precondition Failed'), { code: 'precondition_failed', etag: 'W/"9"' }));
    const { onChanged } = renderTab(MEMBER);

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Fleet routing EU' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/^This composition changed since you opened it \(412 · precondition_failed\)\. It has been read again/)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Fleet routing EU');
  });

  it('archives and restores with the switch', async () => {
    renderTab(MEMBER);

    fireEvent.click(screen.getByRole('switch', { name: 'Archived' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('isa-demo', 'fleet-routing', { archived: true }, 'W/"7"'));
    expect(await screen.findByText('Composition archived.')).toBeInTheDocument();
  });

  it('asks an ADMIN before publishing, saying exactly what publishing exposes', async () => {
    renderTab(ADMIN);

    fireEvent.click(screen.getByRole('button', { name: 'Make public' }));
    const dialog = screen.getByRole('dialog', { name: 'Make Fleet routing public?' });
    expect(within(dialog).getByText(PUBLISH_CONFIRMATION)).toBeInTheDocument();
    expect(PUBLISH_CONFIRMATION).toBe(
      'Public compositions show every version’s document to anyone, as written: the problem reference, the run and point recorded as '
      + 'evidence, the values and their verification status. The problem itself, its runs and evaluation diagnostics stay private. '
      + 'A fork’s source is named only while that source is public.',
    );
    expect(api.update).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make public' }));

    await waitFor(() => expect(api.update).toHaveBeenCalledWith('isa-demo', 'fleet-routing', { visibility: 'public' }, 'W/"7"'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('The composition is public: anybody reads it.')).toBeInTheDocument();
  });

  it('makes a public composition private without a question', async () => {
    renderTab(ADMIN, { ...composition, visibility: 'public' });

    fireEvent.click(screen.getByRole('button', { name: 'Make private' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('isa-demo', 'fleet-routing', { visibility: 'private' }, 'W/"7"'));
  });

  it('says a refused visibility change needs ADMIN', async () => {
    api.update.mockRejectedValue(Object.assign(new HttpError(403, 'Forbidden'), { code: 'organization_forbidden' }));
    renderTab(ADMIN);

    fireEvent.click(screen.getByRole('button', { name: 'Make public' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Make public' }));
    expect(await screen.findByText('Changing who reads a composition needs ADMIN in this organization (403 · organization_forbidden). Nothing changed.')).toBeInTheDocument();
  });

  it('deletes only once the slug is typed, then opens the list with a notice', async () => {
    renderTab(ADMIN);

    fireEvent.click(screen.getByRole('button', { name: 'Delete composition' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Fleet routing?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type fleet-routing to confirm' }), { target: { value: 'Fleet-routing' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type fleet-routing to confirm' }), { target: { value: 'fleet-routing' } });
    fireEvent.click(confirm);

    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('isa-demo', 'fleet-routing'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/app/isa-demo/compositions{"toast":"Composition “Fleet routing” deleted."}'));
  });

  it('keeps the composition when the delete is refused, and says why', async () => {
    api.remove.mockRejectedValue(Object.assign(new HttpError(403, 'Forbidden'), { code: 'organization_forbidden' }));
    renderTab(ADMIN);

    fireEvent.click(screen.getByRole('button', { name: 'Delete composition' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Fleet routing?' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type fleet-routing to confirm' }), { target: { value: 'fleet-routing' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Deleting a composition needs ADMIN in this organization (403 · organization_forbidden). Nothing was deleted.');
    expect(screen.getByTestId('where')).toHaveTextContent('/app/isa-demo/compositions/fleet-routing/settings');
  });
});
