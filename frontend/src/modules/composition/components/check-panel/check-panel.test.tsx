import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import current from '../../../../test/fixtures/core/tomatometer.check.production.json';
import newer from '../../../../test/fixtures/core/tomatometer.check.production.newer.json';
import { fakeGateway, renderModule } from '../../../../test/moduleKit';
import CheckPanel from '.';

const CHECK =
  'POST /v1/organizations/fixtures/compositions/tomatometer/environments/production/check';

const run = async (body: unknown) => {
  renderModule(
    <CheckPanel org="fixtures" composition="tomatometer" environment="production" adopted />,
    { gateway: fakeGateway({ [CHECK]: { body } }) }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
  return screen.findByRole('list', { name: 'Check report' });
};

describe('the check panel', () => {
  it('says each source is the latest when the gateway found nothing newer, and that nothing changed', async () => {
    const report = await run(current);
    const rows = within(report).getAllByRole('listitem');
    expect(rows.at(-2)).toHaveTextContent('sphere/tomatometer 1.0.0 is the latest.');
    expect(rows.at(-1)).toHaveTextContent('Valid on the installed toolchain.');
    for (const row of rows.slice(0, -2)) expect(row).toHaveTextContent(/is the latest.*Latest$/);
    expect(
      screen.getByText(
        /Nothing was changed\. OpenBinding also watches these pricings every few minutes/
      )
    ).toBeInTheDocument();
  });

  it('names the newer version against the pinned one', async () => {
    const report = await run(newer);
    expect(report).toHaveTextContent(
      'Brevo 2026-11 is newer than the pinned 2026-10 (plan PROFESSIONAL).'
    );
    expect(report).toHaveTextContent('Dropbox 2021 is the latest (plan PLUS).');
  });
});
