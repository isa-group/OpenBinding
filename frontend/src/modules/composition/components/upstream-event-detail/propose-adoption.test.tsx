import { fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { CompositionEnvironmentView, UpstreamEventDetail } from '../../../core/api/types';
import environmentsList from '../../../../test/fixtures/core/tomatometer.environments.json';
import resolved from '../../../../test/fixtures/core/zproposals.upstream-event.resolved.json';
import pending from '../../../../test/fixtures/core/zproposals.pending.json';
import completed from '../../../../test/fixtures/core/zproposals.completed.json';
import { fakeGateway, renderModule } from '../../../../test/moduleKit';
import ProposeAdoption from './ProposeAdoption';

const ORG = '/v1/organizations/fixtures';
const PROPOSALS = `${ORG}/compositions/tomatometer/proposals`;
const environments = environmentsList.environments as unknown as CompositionEnvironmentView[];
// The event resolved by 1.2.0, while production still holds the affected 1.0.0.
const event = { ...resolved, environments: ['production'] } as unknown as UpstreamEventDetail;

/** The tab around the button: after a change it reads the environments again, and production now holds 1.2.0. */
function Tab() {
  const [shown, setShown] = useState(environments);
  return (
    <>
      <h2 tabIndex={-1} id="event-heading">
        brevo
      </h2>
      <ProposeAdoption
        org="fixtures"
        composition="tomatometer"
        event={event}
        environments={shown}
        role="ADMIN"
        onFocusAway={() => document.getElementById('event-heading')?.focus()}
        onChanged={() =>
          setShown(
            environments.map(environment =>
              environment.slug === 'production' && environment.inEffect
                ? {
                    ...environment,
                    inEffect: {
                      ...environment.inEffect,
                      version: { ...resolved.resolvedBy.version, ordinal: 3 },
                    },
                  }
                : environment
            )
          )
        }
      />
    </>
  );
}

describe('proposing to adopt the version that resolved an event', () => {
  it('says why the gateway refused it, from the reasons of its 422', async () => {
    renderModule(<Tab />, {
      gateway: fakeGateway({
        [`POST ${PROPOSALS}`]: {
          status: 422,
          body: {
            type: 'about:blank',
            title: 'Unprocessable Content',
            status: 422,
            code: 'proposal_invalid',
            detail: 'The proposal cannot be made; `errors` says why, step by step.',
            errors: [
              {
                step: 1,
                code: 'already_in_effect',
                message: 'Version 1.2.0 is already in effect in this environment.',
              },
            ],
          },
        },
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Propose adopting 1.2.0 in production' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The proposal couldn’t be made: Version 1.2.0 is already in effect in this environment.'
    );
  });

  it('keeps the proposal on screen after the adoption it applied leaves nothing to propose', async () => {
    renderModule(<Tab />, {
      gateway: fakeGateway({
        [`POST ${PROPOSALS}`]: { status: 201, body: pending },
        [`POST ${ORG}/proposals/${pending.id}/confirm`]: { body: completed },
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Propose adopting 1.2.0 in production' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Adopt the version that resolved it',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and apply' }));
    // The tab read the environments again: production holds 1.2.0, so nothing is offered, and the outcome stays.
    expect(await within(dialog).findByText('Applied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Propose adopting/ })).toBeNull();
    expect(
      screen.getByRole('dialog', { name: 'Adopt the version that resolved it' })
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    // The button that opened it is gone: focus goes to the event's heading, not to the page.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'brevo' }));
  });
});
