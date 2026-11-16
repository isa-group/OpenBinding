import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrganizationPicker } from './OrganizationPicker';

const platform = vi.hoisted(() => ({ organizations: vi.fn() }));

vi.mock('../../api/platform', () => ({ platformApi: platform }));

const renderPicker = () => render(
  <MemoryRouter>
    <OrganizationPicker label="Save to an organization" destination={(org) => `/app/${org}/problem-editor`} />
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
    expect(await screen.findByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo/problem-editor');
    expect(screen.getByRole('link', { name: 'QoS Lab' })).toHaveAttribute('href', '/app/qos-lab/problem-editor');
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

  describe('as a choice (mode="select")', () => {
    const organizations = [
      { id: 'o1', slug: 'isa-demo', name: 'ISA Demo Group', parent_id: null, effective_role: 'OWNER' as const, created_at: '2026-03-03T00:00:00Z' },
      { id: 'o2', slug: 'qos-lab', name: 'QoS Lab', parent_id: null, effective_role: 'MEMBER' as const, created_at: '2026-03-03T00:00:00Z' },
      { id: 'o3', slug: 'read-lab', name: 'Read Lab', parent_id: null, effective_role: 'VIEWER' as const, created_at: '2026-03-03T00:00:00Z' },
    ];

    it('lists the organizations at once as one choice, disabling those with a reason and saying it beside them', async () => {
      platform.organizations.mockResolvedValue(organizations);
      const onChange = vi.fn();
      render(
        <MemoryRouter>
          <OrganizationPicker
            mode="select"
            label="Fork into"
            value={null}
            onChange={onChange}
            disabledReason={(organization) => (organization.effective_role === 'VIEWER' ? 'needs member access' : null)}
          />
        </MemoryRouter>,
      );

      expect(screen.getByRole('status')).toHaveTextContent('Loading your organizations…');
      const group = screen.getByRole('group', { name: 'Fork into' });
      const read = await screen.findByRole('radio', { name: 'Read Lab' });
      expect(read).toBeDisabled();
      expect(read).toHaveAccessibleDescription('needs member access');
      expect(screen.getByRole('radio', { name: 'ISA Demo Group' })).toBeEnabled();
      expect(group).toContainElement(read);

      fireEvent.click(screen.getByRole('radio', { name: 'QoS Lab' }));
      expect(onChange).toHaveBeenCalledWith(organizations[1]);
      expect(platform.organizations).toHaveBeenCalledTimes(1);
    });

    it('marks the chosen organization, and offers a retry when the list fails', async () => {
      platform.organizations.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(organizations);
      render(<MemoryRouter><OrganizationPicker mode="select" label="Fork into" value="qos-lab" onChange={vi.fn()} /></MemoryRouter>);

      expect(await screen.findByRole('alert')).toHaveTextContent('Your organizations couldn’t be loaded.');
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('radio', { name: 'QoS Lab' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'ISA Demo Group' })).not.toBeChecked();
    });
  });
});
