import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SphereVersionView } from '../../api/sphereApi';
import mailgunView from '../../../../test/fixtures/sphere/version.mailgun.json';
import mailgunYaml from '../../../../test/fixtures/sphere/6ade364540e55445692b0eda.6ade36454b2b5b01c587db3d.yml?raw';
import PlanPicker from './plan-picker';
import { importablePlans, readSummary } from './summary';

const summary = readSummary(mailgunView as SphereVersionView);

describe('PlanPicker', () => {
  it('offers every public plan with a readable price, and disables a private one with the summary’s reason', () => {
    render(
      <PlanPicker
        yaml={mailgunYaml}
        summary={summary}
        value={{ plans: [], addons: [] }}
        onChange={vi.fn()}
      />
    );
    expect(importablePlans(summary)).toEqual(['FREE', 'BASIC', 'FOUNDATION', 'SCALE']);
    const enterprise = screen.getByRole('checkbox', { name: /^ENTERPRISE/ });
    expect(enterprise).toBeDisabled();
    expect(enterprise).toHaveAccessibleDescription('Private in this pricing');
    expect(screen.getByRole('checkbox', { name: /^FOUNDATION/ })).toHaveAccessibleName(
      /FOUNDATION\s*35 USD\/month/
    );
  });

  it('includes a plan and offers the add-ons that go with it as variants', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PlanPicker
        yaml={mailgunYaml}
        summary={summary}
        value={{ plans: [], addons: [] }}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /^FOUNDATION/ }));
    expect(onChange).toHaveBeenLastCalledWith({ plans: ['FOUNDATION'], addons: [] });
    rerender(
      <PlanPicker
        yaml={mailgunYaml}
        summary={summary}
        value={{ plans: ['FOUNDATION'], addons: [] }}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /^dedicatedIp/ }));
    expect(onChange).toHaveBeenLastCalledWith({ plans: ['FOUNDATION'], addons: ['dedicatedIp'] });
  });

  it('drops a variant when no chosen plan takes it any more', () => {
    const onChange = vi.fn();
    render(
      <PlanPicker
        yaml={mailgunYaml}
        summary={summary}
        value={{ plans: ['FOUNDATION'], addons: ['dedicatedIp'] }}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /^FOUNDATION/ }));
    expect(onChange).toHaveBeenLastCalledWith({ plans: [], addons: [] });
  });

  it('lists the add-ons charged per use apart, as not imported', () => {
    render(
      <PlanPicker
        yaml={mailgunYaml}
        summary={summary}
        value={{ plans: [], addons: [] }}
        onChange={vi.fn()}
      />
    );
    const metered = screen.getByRole('region', { name: 'Charged per use' });
    expect(metered).toHaveTextContent('Charged per use, not imported');
    expect(metered).toHaveTextContent('extraEmailsFoundation: 1.3 USD per 1000 emails');
  });
});
