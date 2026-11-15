import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { Organization } from '../../api/platform';
import type { CompositionVersionView, CompositionView } from '../../shared/api/types';
import fmsVersion from '../../test/fixtures/core/fms.version.json';
import { ForkCompositionDialog } from './ForkCompositionDialog';

const api = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('../../entities/composition/api', () => ({ compositionsApi: api }));

const platform = vi.hoisted(() => ({ organizations: vi.fn() }));
vi.mock('../../api/platform', () => ({ platformApi: platform }));

const organization = (slug: string, name: string, role: Organization['effective_role']): Organization => ({
  id: `org-${slug}`, slug, name, parent_id: null, effective_role: role, created_at: '2026-03-03T00:00:00Z',
});
const ORGANIZATIONS = [
  organization('isa-demo', 'ISA Demo Group', 'OWNER'),
  organization('qos-lab', 'QoS Lab', 'MEMBER'),
  organization('read-lab', 'Read Lab', 'VIEWER'),
];

const composition: CompositionView = {
  id: 'composition-fleet', slug: 'fleet-routing', name: 'Fleet routing', description: '', kind: 'workflow', archived: false,
  visibility: 'public', organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' }, created_by_id: null,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', version_count: 3,
  latest_version: { id: 'v3', ordinal: 3, label: '1.2.0', values_status: 'verified', created_at: '2026-10-01T00:00:00Z' },
};

const linked = { ...(structuredClone(fmsVersion) as CompositionVersionView), id: 'v3', label: '1.2.0' };
const declared: CompositionVersionView = { ...linked, problem: null, values_status: 'declared' };

const forked = (slug: string, droppedProblem: boolean) => ({
  status: 'forked' as const,
  result: {
    composition: { ...composition, slug, organization: { id: 'org-qos-lab', slug: 'qos-lab', name: 'QoS Lab' }, visibility: 'private' as const },
    version: declared,
    droppedProblem,
  },
});

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname}{JSON.stringify(where.state ?? null)}</output>;
}

function renderDialog(version: CompositionVersionView = linked) {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/app/isa-demo/compositions/fleet-routing']}>
      <Routes>
        <Route path="*" element={<><ForkCompositionDialog composition={composition} version={version} onClose={onClose} /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose, dialog: screen.getByRole('dialog', { name: 'Fork this composition' }) };
}

const where = () => screen.getByTestId('where').textContent;

describe('ForkCompositionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.organizations.mockResolvedValue(ORGANIZATIONS);
  });

  it('offers the account’s organizations, never the source’s own, nor one where it is below MEMBER', async () => {
    const { dialog } = renderDialog();

    const own = await within(dialog).findByRole('radio', { name: 'ISA Demo Group' });
    expect(own).toBeDisabled();
    expect(own).toHaveAccessibleDescription('Forks go to another organization; to change this composition, create a new version');
    const read = within(dialog).getByRole('radio', { name: 'Read Lab' });
    expect(read).toBeDisabled();
    expect(read).toHaveAccessibleDescription('needs member access');
    expect(within(dialog).getByRole('radio', { name: 'QoS Lab' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('forks a declared version at once, and opens the private copy', async () => {
    api.fork.mockResolvedValue(forked('fleet-routing', false));
    const { dialog } = renderDialog(declared);

    fireEvent.click(await within(dialog).findByRole('radio', { name: 'QoS Lab' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fork' }));

    await waitFor(() => expect(api.fork).toHaveBeenCalledWith('isa-demo', 'fleet-routing', { version: 'v3', targetOrganization: 'qos-lab', dropProblem: false }));
    await waitFor(() => expect(where()).toBe('/app/qos-lab/compositions/fleet-routing{"toast":"Forked. The copy is private."}'));
  });

  it('asks on purpose before a linked version drops its problem, and sends dropProblem only then', async () => {
    api.fork.mockResolvedValue(forked('fleet-routing', true));
    const { dialog } = renderDialog();

    fireEvent.click(await within(dialog).findByRole('radio', { name: 'QoS Lab' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByText(
      'This version links a problem of ISA Demo Group, which QoS Lab cannot read. Forking removes the link and the evidence, and seals the copy with declared values.',
    )).toBeInTheDocument();
    const confirm = within(dialog).getByRole('checkbox', { name: /Fork without the problem/ });
    expect(confirm).not.toBeChecked();
    const fork = within(dialog).getByRole('button', { name: 'Fork' });
    expect(fork).toBeDisabled();
    fireEvent.click(fork);
    expect(api.fork).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    fireEvent.click(fork);
    await waitFor(() => expect(api.fork).toHaveBeenCalledWith('isa-demo', 'fleet-routing', { version: 'v3', targetOrganization: 'qos-lab', dropProblem: true }));
    await waitFor(() => expect(where()).toBe('/app/qos-lab/compositions/fleet-routing{"toast":"Forked. The copy is private. Values are declared."}'));
  });

  it('asks for a different name when the target holds the address, and refuses the taken name in any case', async () => {
    api.fork
      .mockResolvedValueOnce({ status: 'nameTaken', existing: { id: 'c-9', slug: 'fleet-routing', name: 'Fleet routing' } })
      .mockResolvedValueOnce(forked('fleet-routing-fork', false));
    const { dialog } = renderDialog(declared);

    fireEvent.click(await within(dialog).findByRole('radio', { name: 'QoS Lab' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fork' }));

    expect(await within(dialog).findByText(/QoS Lab already has a composition at/)).toHaveTextContent('named “Fleet routing”');
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    const address = within(dialog).getByRole('textbox', { name: 'Address' });
    expect(name).toHaveValue('Fleet routing (fork)');
    expect(address).toHaveValue('fleet-routing-fork');
    const submit = within(dialog).getByRole('button', { name: 'Fork as a new composition' });

    fireEvent.change(name, { target: { value: 'FLEET ROUTING ' } });
    expect(within(dialog).getByText('That is the name of the composition already there. Choose a different one.')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.change(address, { target: { value: 'fleet-routing' } });
    expect(within(dialog).getByText('fleet-routing is in use in QoS Lab. Choose another address.')).toBeInTheDocument();

    fireEvent.change(name, { target: { value: 'Fleet routing EU' } });
    fireEvent.change(address, { target: { value: 'fleet-routing-fork' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.fork).toHaveBeenLastCalledWith('isa-demo', 'fleet-routing', {
      version: 'v3', targetOrganization: 'qos-lab', dropProblem: false, slug: 'fleet-routing-fork', name: 'Fleet routing EU',
    }));
    await waitFor(() => expect(where()).toBe('/app/qos-lab/compositions/fleet-routing-fork{"toast":"Forked. The copy is private."}'));
  });

  it('says a taken explicit address at the address field (409 slug_conflict)', async () => {
    api.fork
      .mockResolvedValueOnce({ status: 'nameTaken', existing: { id: 'c-9', slug: 'fleet-routing', name: 'Fleet routing' } })
      .mockRejectedValueOnce(Object.assign(new HttpError(409, 'Conflict'), { code: 'slug_conflict' }));
    const { dialog } = renderDialog(declared);

    fireEvent.click(await within(dialog).findByRole('radio', { name: 'QoS Lab' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fork' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Fork as a new composition' }));

    const address = await within(dialog).findByRole('textbox', { name: 'Address' });
    await waitFor(() => expect(address).toHaveAccessibleDescription('fleet-routing-fork is in use in QoS Lab (409 · slug_conflict). Choose another address.'));
    expect(address).toHaveAttribute('aria-invalid', 'true');
    expect(where()).toBe('/app/isa-demo/compositions/fleet-routingnull');
  });

  it.each([
    [403, 'api_key_boundary', 'This API key does not reach QoS Lab (403 · api_key_boundary), so nothing was forked.'],
    [403, 'feature_not_entitled', 'Your plan does not include the composition repository (403 · feature_not_entitled), so nothing was forked.'],
    [404, 'not_found', 'This composition or version is not there any more, or you can no longer read it (404 · not_found).'],
    [409, 'composition_fork_same_organization', 'A fork goes to another organization (409 · composition_fork_same_organization). To change this composition, create a new version of it instead.'],
    [409, 'composition_fork_problem_unreadable', 'This version links a problem, which QoS Lab cannot read (409 · composition_fork_problem_unreadable). Confirm that the fork drops it, and fork again.'],
  ])('says what a %s %s means, and stays open', async (status, code, message) => {
    api.fork.mockRejectedValue(Object.assign(new HttpError(status, 'Refused'), { code }));
    const { dialog, onClose } = renderDialog(declared);

    fireEvent.click(await within(dialog).findByRole('radio', { name: 'QoS Lab' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fork' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lists the findings of a 422', async () => {
    api.fork.mockRejectedValue(Object.assign(new HttpError(422, 'Unprocessable'), {
      code: 'composition_invalid',
      diagnostics: [{ code: 'c2y_from_registry_unknown', message: 'registry "lab" is not defined here', severity: 'error', path: 'binding.T1.from', pointer: '/binding/T1/from', span: null }],
    }));
    const { dialog } = renderDialog(declared);

    fireEvent.click(await within(dialog).findByRole('radio', { name: 'QoS Lab' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fork' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('The forked document has errors (422 · composition_invalid). The gateway found:');
    expect(within(alert).getByRole('list', { name: 'What the gateway found' })).toHaveTextContent('registry "lab" is not defined here /binding/T1/from c2y_from_registry_unknown');
  });

  it('closes on Cancel', async () => {
    const { dialog, onClose } = renderDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
