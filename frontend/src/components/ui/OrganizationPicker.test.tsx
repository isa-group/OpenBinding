import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrganizationPicker } from './OrganizationPicker';

const platform = vi.hoisted(() => ({ organizations: vi.fn() }));

vi.mock('../../api/platform', () => ({ platformApi: platform }));

const renderPicker = () => render(
  <MemoryRouter>
    <OrganizationPicker label="Save to an organization" destination={(org) => `/app/${org}/workbench`} />
  </MemoryRouter>,
);

describe('OrganizationPicker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the account’s organizations when it opens, each leading to its destination', async () => {
    platform.organizations.mockResolvedValue([{ id: 'o1', slug: 'isa-demo', name: 'ISA Demo Group' }, { id: 'o2', slug: 'qos-lab', name: 'QoS Lab' }]);
    renderPicker();

    expect(platform.organizations).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Save to an organization' });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo/workbench');
    expect(screen.getByRole('link', { name: 'QoS Lab' })).toHaveAttribute('href', '/app/qos-lab/workbench');
  });

  it('says when the account is in no organization, and offers a retry when the list fails', async () => {
    platform.organizations.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
    renderPicker();

    fireEvent.click(screen.getByRole('button', { name: 'Save to an organization' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your organizations couldn’t be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/You’re in no organization yet\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open your workspace' })).toHaveAttribute('href', '/app');
  });
});
