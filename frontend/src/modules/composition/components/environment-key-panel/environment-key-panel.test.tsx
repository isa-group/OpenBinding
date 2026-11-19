import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompositionEnvironmentView } from '../../../core/api/types';
import production from '../../../../test/fixtures/core/tomatometer.environment.production.json';
import created from '../../../../test/fixtures/core/tomatometer.key.created.json';
import { fakeGateway, renderModule } from '../../../../test/moduleKit';
import EnvironmentKeyPanel from '.';

const ROOT = '/v1/organizations/fixtures/compositions/tomatometer/environments/production';
const environment = production as unknown as CompositionEnvironmentView;

describe('the feed key panel', () => {
  it('shows the feed address to every member and the keys only to an admin', () => {
    renderModule(
      <EnvironmentKeyPanel
        org="fixtures"
        composition="tomatometer"
        environment={environment}
        canAdminister={false}
        onChanged={() => {}}
      />
    );
    expect(screen.getByText(/\/environments\/production\/composition$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy feed address' })).toBeInTheDocument();
    expect(screen.getByText(/One live feed key\./)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Feed keys' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create key' })).toBeNull();
  });

  it('reveals a new key once, and forgets it on dismissal', async () => {
    const onChanged = vi.fn();
    renderModule(
      <EnvironmentKeyPanel
        org="fixtures"
        composition="tomatometer"
        environment={environment}
        canAdminister
        onChanged={onChanged}
      />,
      {
        gateway: fakeGateway({
          [`POST ${ROOT}/keys`]: ({ body }) => {
            expect(body).toEqual({ label: 'TomatoMeter canary' });
            return { status: 201, body: created };
          },
        }),
      }
    );
    const keys = screen.getByRole('list', { name: 'Feed keys' });
    expect(keys).toHaveTextContent('obe_f1c7a5e0…');
    expect(keys).toHaveTextContent('never used');
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Key label' }), {
      target: { value: 'TomatoMeter canary' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const secret = await screen.findByLabelText('Secret');
    expect(secret).toHaveTextContent(created.secret);
    expect(
      screen.getByText(/Copy this key now\. You won’t be able to see it again\./)
    ).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByLabelText('Secret')).toBeNull());
    expect(document.body.textContent).not.toContain(created.secret);
    expect(JSON.stringify({ ...localStorage })).not.toContain(created.secret);
  });

  it('refuses a third live key before asking', () => {
    const two = {
      ...environment,
      keys: [...environment.keys!, { ...environment.keys![0], id: 'k2', hint: 'obe_2…' }],
      keyCount: 2,
    };
    renderModule(
      <EnvironmentKeyPanel
        org="fixtures"
        composition="tomatometer"
        environment={two}
        canAdminister
        onChanged={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled();
    expect(screen.getByText(/Two live keys, the most an environment has/)).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Feed keys' })).getAllByRole('button', {
        name: 'Revoke',
      })
    ).toHaveLength(2);
  });
});
