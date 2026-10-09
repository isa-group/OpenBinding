import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { States } from './States';

function renderGallery() {
  return render(<MemoryRouter><States /></MemoryRouter>);
}

/** The state cards of the gallery (the anatomy cards below them are articles too). */
const cards = () => Array.from(document.querySelectorAll<HTMLElement>('article.ui-state'));

describe('States gallery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows every family of state with its status chip and a way forward', () => {
    renderGallery();

    expect(screen.getByRole('heading', { level: 1, name: 'States and recoverable errors' })).toBeInTheDocument();
    const chips = cards().map((card) => card.querySelector('.ui-state-chip')?.textContent);
    expect(cards()).toHaveLength(13);
    expect(chips).toEqual(expect.arrayContaining(['401', '402', '403', '404', '429', '503', 'OPTION_CLAMPED', 'token', 'dates']));
    expect(screen.getByRole('heading', { name: 'Your session ended' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in again' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'See my usage' })).toHaveAttribute('href', '/app/account/usage');
    expect(screen.getByRole('link', { name: 'Create a key with this permission' })).toHaveAttribute('href', '/app/account/keys/new');
    expect(screen.getByRole('link', { name: 'Go to my jobs' })).toHaveAttribute('href', '/app/jobs');
  });

  it('narrows the gallery to one family at a time', () => {
    renderGallery();
    const all = cards().length;

    fireEvent.click(screen.getByRole('button', { name: 'Quota' }));
    expect(screen.getByRole('button', { name: 'Quota' })).toHaveAttribute('aria-pressed', 'true');
    expect(cards().map((card) => card.querySelector('.ui-state-chip')?.textContent)).toEqual(['402', '402', '402']);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '10');

    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    expect(cards()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(cards()).toHaveLength(all);
  });

  it('counts a 429 down and enables the retry only when it ends', () => {
    vi.useFakeTimers();
    renderGallery();
    fireEvent.click(screen.getByRole('button', { name: 'Busy & unavailable' }));
    const retry = screen.getByRole('button', { name: 'Retry now' });

    expect(retry).toBeDisabled();
    expect(screen.getByText('Retry is available when the countdown ends.')).toBeInTheDocument();
    // One tick per second: each one is a state update that schedules the next.
    for (let second = 0; second < 15; second += 1) act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('A slot may be free now.')).toBeInTheDocument();
    expect(retry).toBeEnabled();
  });

  it('shows a short “checking” while a 503 is retried', () => {
    vi.useFakeTimers();
    renderGallery();
    fireEvent.click(screen.getByRole('button', { name: 'Busy & unavailable' }));

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    act(() => { vi.advanceTimersByTime(1300); });
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
  });

  it('explains what the browser knows about plan features in each token state', () => {
    renderGallery();
    fireEvent.click(screen.getByRole('button', { name: 'Warnings & dates' }));
    const card = screen.getByRole('article', { name: /Plan features/ });

    expect(within(card).getByRole('heading', { name: 'Plan features: can’t confirm' })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Present' }));
    expect(within(card).getByRole('heading', { name: 'Plan features: confirmed' })).toBeInTheDocument();
    expect(within(card).getByText(/the server still checks every action/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Expired' }));
    expect(within(card).getByText(/We hide the feature states until a fresh one arrives/)).toBeInTheDocument();
  });

  it('lays the clamped option out as a table a screen reader can navigate', () => {
    renderGallery();
    fireEvent.click(screen.getByRole('button', { name: 'Warnings & dates' }));

    const table = screen.getByRole('table', { name: 'Options that were reduced to the plan’s ceiling' });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Option', 'Requested', 'Applied', 'Unit']);
    expect(within(table).getByRole('rowheader')).toHaveTextContent('iterations');
  });

  it('explains how both error formats become one message', () => {
    renderGallery();

    const section = screen.getByRole('region', { name: 'How an error becomes a message' });
    expect(within(section).getAllByRole('article')).toHaveLength(2);
    expect(within(section).getByText('Busy job slots (429)')).toBeInTheDocument();
    expect(within(section).getAllByText(/is shown as/)).toHaveLength(10);
  });
});
