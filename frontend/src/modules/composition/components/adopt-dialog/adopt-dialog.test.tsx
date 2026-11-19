import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompositionVersionView, CompositionView } from '../../../core/api/types';
import environments from '../../../../test/fixtures/core/tomatometer.environments.json';
import production from '../../../../test/fixtures/core/tomatometer.environment.production.json';
import versionList from '../../../../test/fixtures/core/tomatometer.versions.json';
import { fakeGateway, renderModule } from '../../../../test/moduleKit';
import AdoptDialog from '.';

const ROOT = '/v1/organizations/fixtures/compositions/tomatometer/environments';
const composition = {
  slug: 'tomatometer',
  name: 'TomatoMeter',
  archived: false,
} as CompositionView;
const versions = versionList.versions as unknown as CompositionVersionView[];

const render = (
  adopt: Parameters<typeof fakeGateway>[0][string],
  role: 'MEMBER' | 'ADMIN' = 'ADMIN'
) => {
  const onAdopted = vi.fn();
  const gateway = fakeGateway({
    [`GET ${ROOT}`]: { body: environments },
    [`GET ${ROOT}/production`]: { body: production, headers: { ETag: '"7"' } },
    [`POST ${ROOT}/production/adopt`]: adopt,
  });
  renderModule(
    <AdoptDialog
      org="fixtures"
      composition={composition}
      versions={versions}
      role={role}
      environment="production"
      onClose={() => {}}
      onAdopted={onAdopted}
    />,
    { gateway }
  );
  return { gateway, onAdopted };
};

describe('the adopt dialog', () => {
  it('disables the version in effect, says when the feed changes, and adopts with the environment’s ETag', async () => {
    const { gateway, onAdopted } = render({ body: { environment: production, adoption: {} } });
    const dialog = await screen.findByRole('dialog', { name: 'Adopt a version' });
    expect(
      await within(dialog).findByText('In effect now: 1.0.0 (adoption #3).')
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /1\.0\.0/ })).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: /1\.1\.0/ })).toBeChecked();
    expect(dialog).toHaveTextContent(
      'The feed changes when you adopt: the application reads 1.1.0 on its next poll.'
    );
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note' }), {
      target: { value: 'Switch to Resend' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adopt 1.1.0' }));
    await waitFor(() => expect(onAdopted).toHaveBeenCalled());
    const [path, init] = gateway.mock.calls.find(([called]) => String(called).endsWith('/adopt'))!;
    expect(path).toBe(`${ROOT}/production/adopt`);
    expect((init as RequestInit).headers).toMatchObject({ 'If-Match': '"7"' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      version: '00000000-0000-4000-8000-000000000038',
      note: 'Switch to Resend',
    });
  });

  it('offers to read the environment again on a 412', async () => {
    render({ status: 412, body: { detail: { code: 'precondition_failed', error: 'Changed.' } } });
    const dialog = await screen.findByRole('dialog', { name: 'Adopt a version' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Adopt 1.1.0' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Someone adopted in Production or changed it since you opened it.'
    );
    expect(within(dialog).getByRole('button', { name: 'Read it again' })).toBeInTheDocument();
  });

  it.each([
    ['evaluation_stale', 'was evaluated with another toolchain', 'Re-evaluate'],
    ['binding_invalid', 'is not valid for its problem', 'Open the version'],
    ['evaluation_semantics_changed', 'derive it again and adopt the new version', 'Derive again'],
  ])('words the 409 %s with its way out', async (code, text, link) => {
    render({ status: 409, body: { detail: { code, error: 'Refused.' } } });
    const dialog = await screen.findByRole('dialog', { name: 'Adopt a version' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Adopt 1.1.0' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
    expect(within(dialog).getByRole('link', { name: link })).toBeInTheDocument();
  });

  it('offers a MEMBER only the environments members adopt in', async () => {
    renderModule(
      <AdoptDialog
        org="fixtures"
        composition={composition}
        versions={versions}
        role="MEMBER"
        onClose={() => {}}
        onAdopted={() => {}}
      />,
      {
        gateway: fakeGateway({
          [`GET ${ROOT}`]: { body: environments },
          [`GET ${ROOT}/staging`]: {
            body: environments.environments[1],
            headers: { ETag: '"2"' },
          },
        }),
      }
    );
    const select = await screen.findByRole('combobox', { name: 'Environment' });
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole('option')
          .map(option => option.textContent)
      ).toEqual(['Staging · nothing adopted'])
    );
  });
});
