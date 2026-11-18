import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SphereExpandView, SphereVersionView } from '../../../api/sphereApi';
import expandEmail from '../../../../../test/fixtures/sphere/expand.tomatometer-email.json';
import recipeEmail from '../../../../../test/fixtures/sphere/recipe.tomatometer-email.json';
import mailgunView from '../../../../../test/fixtures/sphere/version.mailgun.json';
import { fromRecipe } from '../recipe';
import { readSummary } from '../summary';
import MappingStep from './MappingStep';
import PreviewStep from './PreviewStep';

const expanded = expandEmail as unknown as SphereExpandView;

describe('PreviewStep', () => {
  it('explains each ineligible candidate from the requirement terms, and says the version compiles', () => {
    render(
      <PreviewStep
        task="dailySummary"
        currency="USD"
        expanded={expanded}
        loading={false}
        failure={null}
        onFill={vi.fn()}
        reviews={[]}
      />
    );
    expect(
      screen.getByText(/The generated version compiles: 7 of 17 candidates/)
    ).toBeInTheDocument();
    const brevoFree = screen.getByText('email.brevo.free', { selector: 'code' }).closest('li')!;
    expect(brevoFree).toHaveTextContent('Ineligible');
    expect(brevoFree).toHaveTextContent('emailsPerDay: 300 < 1000');
    expect(
      screen.getByText('email.mailgun.foundation', { selector: 'li > code' }).closest('li')
    ).toHaveTextContent('Eligible');
    expect(screen.getByText(/17 added, 0 removed, 0 changed/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Candidate values' })).toBeInTheDocument();
  });

  it('asks for a value left to set by hand and hands it over to preview again', () => {
    const onFill = vi.fn();
    const missing: SphereExpandView = {
      ...expanded,
      valid: false,
      diagnostics: [
        ...expanded.diagnostics,
        {
          at: 'sphere-email/email.mailgun.foundation',
          code: 'sphere_property_unmapped',
          message: 'No value is set by hand for latency here.',
          severity: 'error',
          target: 'latency',
        },
      ],
    };
    render(
      <PreviewStep
        task="dailySummary"
        currency="USD"
        expanded={missing}
        loading={false}
        failure={null}
        onFill={onFill}
        reviews={[]}
      />
    );
    expect(screen.getByText(/can’t generate a version yet/)).toBeInTheDocument();
    const field = screen.getByRole('spinbutton', { name: 'latency for email.mailgun.foundation' });
    fireEvent.change(field, { target: { value: '210' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set and preview again' }));
    expect(onFill).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'latency', key: 'mailgun.FOUNDATION' }),
      210
    );
  });

  it('shows why the preview failed', () => {
    render(
      <PreviewStep
        task="dailySummary"
        currency="USD"
        expanded={null}
        loading={false}
        failure="SPHERE is busy; preview again in 3 s."
        onFill={vi.fn()}
        reviews={[]}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('SPHERE is busy; preview again in 3 s.');
  });
});

describe('MappingStep', () => {
  const form = fromRecipe(recipeEmail.recipe as never);
  const summaries = { [form.sources[0].versionId]: readSummary(mailgunView as SphereVersionView) };

  it('shows how each feature is read and the demand and requirements of the recipe', () => {
    render(
      <MappingStep form={form} onForm={vi.fn()} summaries={summaries} editableFeatures={false} />
    );
    expect(screen.getByRole('combobox', { name: 'Read availability from' })).toHaveValue(
      'guarantee'
    );
    expect(screen.getByRole('combobox', { name: 'The guarantee availability reads' })).toHaveValue(
      'guaranteedUptimeSla'
    );
    expect(screen.getByRole('spinbutton', { name: 'When guaranteedUptimeSla is yes' })).toHaveValue(
      0.9995
    );
    expect(screen.getByRole('combobox', { name: 'Read subscription from' })).toHaveValue('price');
    expect(
      screen
        .getAllByRole('combobox', { name: 'Limit at least' })
        .map(select => (select as HTMLSelectElement).value)
    ).toEqual(['emailsPerDay', 'emailsPerMonth']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('changes how a feature is read, and refuses a demand above unlimited', () => {
    const onForm = vi.fn();
    const { rerender } = render(
      <MappingStep form={form} onForm={onForm} summaries={summaries} editableFeatures={false} />
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Read latency from' }), {
      target: { value: 'constant' },
    });
    expect(onForm.mock.calls.at(-1)?.[0].properties.latency.kind).toBe('constant');
    const huge = {
      ...form,
      demand: [{ name: 'dailyEmails', value: 2e8, unit: 'email/day' }, form.demand[1]],
    };
    rerender(
      <MappingStep form={huge} onForm={onForm} summaries={summaries} editableFeatures={false} />
    );
    expect(within(screen.getByRole('alert')).getByText(/above 1e\+8/)).toBeInTheDocument();
  });
});
