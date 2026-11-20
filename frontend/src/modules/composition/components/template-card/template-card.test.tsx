import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompositionTemplateSummary } from '../../../core/api/types';
import catalog from '../../../../test/fixtures/core/templates.json';
import TemplateCard from '.';

const [fms, tomatometer] = catalog.templates as CompositionTemplateSummary[];

describe('the template card', () => {
  it('names the template, its kind and tasks, and whether it reads SPHERE', () => {
    const onUse = vi.fn();
    render(<TemplateCard template={tomatometer} onUse={onUse} />);
    const card = screen.getByRole('article', { name: 'Template TomatoMeter composite' });
    expect(card).toHaveTextContent('Application');
    expect(card).toHaveTextContent('Uses SPHERE · has an offering');
    fireEvent.click(screen.getByRole('button', { name: 'Use this template' }));
    expect(onUse).toHaveBeenCalled();
  });

  it('stays listed but disabled, with its reason, when the installation cannot start it', () => {
    render(
      <TemplateCard
        template={{ ...tomatometer, available: false, unavailableReason: 'sphere_disabled' }}
        onUse={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: 'Use this template' })).toBeDisabled();
    expect(
      screen.getByText('It reads SPHERE, which this installation has turned off.')
    ).toBeInTheDocument();
  });

  it('says nothing about SPHERE for a template without an offering', () => {
    render(<TemplateCard template={fms} onUse={() => {}} />);
    expect(screen.queryByText(/Uses SPHERE/)).toBeNull();
  });
});
