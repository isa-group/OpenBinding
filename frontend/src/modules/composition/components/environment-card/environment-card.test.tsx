import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompositionEnvironmentView } from '../../../core/api/types';
import environments from '../../../../test/fixtures/core/tomatometer.environments.json';
import { renderModule } from '../../../../test/moduleKit';
import EnvironmentCard from '.';

const [production, staging] = environments.environments as CompositionEnvironmentView[];

describe('the environment card', () => {
  it('names the version in effect, its adoption, who adopted it and the operator, and links to the detail', () => {
    renderModule(<EnvironmentCard environment={production} to="/here?environment=production" />);
    const card = screen.getByRole('article', { name: 'Environment Production' });
    expect(card).toHaveTextContent('In effect1.0.0');
    expect(card).toHaveTextContent('Adoption #3');
    expect(card).toHaveTextContent(/adopted .* ago by fixtures/);
    expect(card).toHaveTextContent('Operator: fixtures');
    expect(card).toHaveTextContent('Admins adopt');
    expect(screen.getByRole('link', { name: 'Production' })).toHaveAttribute(
      'href',
      '/here?environment=production'
    );
    // Nobody may adopt here: no Adopt, and no kebab without entries.
    expect(screen.queryByRole('button', { name: 'Adopt…' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('says nothing is adopted in an empty environment, and offers Adopt and the kebab when given', () => {
    const onAdopt = vi.fn();
    const edit = vi.fn();
    renderModule(
      <EnvironmentCard
        environment={staging}
        to="/here?environment=staging"
        onAdopt={onAdopt}
        menuItems={[{ label: 'Edit', onClick: edit }]}
      />
    );
    expect(screen.getByRole('article', { name: `Environment ${staging.name}` })).toHaveTextContent(
      'Nothing adopted yet'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Adopt…' }));
    expect(onAdopt).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${staging.name}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(edit).toHaveBeenCalled();
  });
});
