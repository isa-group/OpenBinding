import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CompositionTemplateSummary } from '../../../core/api/types';
import catalog from '../../../../test/fixtures/core/templates.json';
import template from '../../../../test/fixtures/core/template.tomatometer.json';
import { fakeGateway, renderModule, type Answer } from '../../../../test/moduleKit';
import InstantiateTemplateDialog from '.';

const tomatometer = catalog.templates[1] as CompositionTemplateSummary;
const FROM = 'POST /v1/organizations/acme/compositions/from-template';

const open = (answer: Answer) =>
  renderModule(
    <InstantiateTemplateDialog
      org="acme"
      organizationName="Acme"
      template={tomatometer}
      onClose={() => {}}
    />,
    {
      gateway: fakeGateway({
        'GET /v1/compositions/templates/tomatometer': { body: template },
        [FROM]: answer,
      }),
    }
  );

describe('the instantiate template dialog', () => {
  it('starts with the template’s addresses and says a taken one at its field', async () => {
    open({ status: 409, body: { detail: { code: 'slug_taken', error: 'Taken.', field: 'slug' } } });
    const dialog = await screen.findByRole('dialog', { name: 'Start from TomatoMeter composite' });
    expect(await within(dialog).findByDisplayValue('tomatometer')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Problem address' })).toHaveValue(
      'tomatometer-email'
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start the composition' }));
    expect(
      await within(dialog).findByText('tomatometer is already a composition of Acme.')
    ).toBeInTheDocument();
  });

  it('links the problem a template made before it stopped', async () => {
    open({
      status: 502,
      body: {
        detail: {
          code: 'template_incomplete',
          error: 'Stopped.',
          problem: { slug: 'tomatometer-email', revision: 2 },
          cause: 'SPHERE did not answer',
        },
      },
    });
    const dialog = await screen.findByRole('dialog', { name: 'Start from TomatoMeter composite' });
    await within(dialog).findByDisplayValue('tomatometer');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start the composition' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The problem tomatometer-email was created, but the template stopped before the composition: SPHERE did not answer.'
    );
    expect(within(dialog).getByRole('link', { name: 'Open the problem' })).toHaveAttribute(
      'href',
      '/problems/acme/tomatometer-email'
    );
  });
});
