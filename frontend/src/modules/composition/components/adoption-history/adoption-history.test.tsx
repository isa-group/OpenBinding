import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import adoptions from '../../../../test/fixtures/core/tomatometer.adoptions.production.json';
import { fakeGateway, renderModule } from '../../../../test/moduleKit';
import AdoptionHistory from '.';

describe('the adoption history', () => {
  it('lists the adoptions newest first, the one in effect tinted, with what each replaced', async () => {
    renderModule(
      <AdoptionHistory
        org="fixtures"
        composition="tomatometer"
        environment="production"
        inEffect={3}
      />,
      {
        gateway: fakeGateway({
          'GET /v1/organizations/fixtures/compositions/tomatometer/environments/production/adoptions':
            { body: adoptions },
        }),
      }
    );
    const rows = await screen.findAllByRole('listitem', { name: /Adoption \d/ });
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual([
      'Adoption 3',
      'Adoption 2',
      'Adoption 1',
    ]);
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(rows[0]).toHaveTextContent('1.1.0 → 1.0.0');
    expect(within(rows[0]).getByText('In effect')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('Back to Brevo');
    expect(within(rows[1]).getByRole('link', { name: 'Compare previous' })).toHaveAttribute(
      'href',
      '/compositions/fixtures/tomatometer/versions?from=1.0.0&to=1.1.0'
    );
    // The first adoption replaced nothing, so it has nothing to compare.
    expect(within(rows[2]).queryByRole('link', { name: 'Compare previous' })).toBeNull();
    expect(rows[2]).toHaveTextContent(
      'Offering version 1.0.0, read when this version was evaluated.'
    );
  });
});
