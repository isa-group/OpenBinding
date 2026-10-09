import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorState, StateAction, type ErrorVariant } from './ErrorState';

const renderState = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('ErrorState', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<[ErrorVariant, string, string, string, string]>([
    ['401', 'Your session ended', 'Log in again', '/login', 'unauthorized · invalid_token'],
    ['402', 'You’ve used all of an allowance', 'See my usage', '/app/account/usage', 'quota_exceeded'],
    ['403', 'You can’t do this', 'Back to the workspace', '/app', 'forbidden'],
    ['404', 'Not found', 'Back to the workspace', '/app', 'not_found'],
    ['503', 'This isn’t available right now', 'Service status', '/status', 'unavailable'],
  ])('says what the %s variant means by default and where to go next', (variant, title, action, href, code) => {
    renderState(<ErrorState variant={variant} />);

    expect(screen.getByRole('article', { name: title })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    expect(screen.getByText(variant)).toBeInTheDocument();
    expect(screen.getByText(code)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: action })).toHaveAttribute('href', href);
  });

  it('lets a screen replace the wording and the actions', () => {
    renderState(
      <ErrorState variant="404" code="job_not_found" title="Job not found" actions={<StateAction to="/app/jobs" tone="link">Go to my jobs</StateAction>}>
        Nothing to open here.
      </ErrorState>,
    );

    expect(screen.getByRole('heading', { name: 'Job not found' })).toBeInTheDocument();
    expect(screen.getByText('job_not_found')).toBeInTheDocument();
    expect(screen.getByText('Nothing to open here.')).toBeInTheDocument();
    expect(screen.queryByText('Back to the workspace')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to my jobs' })).toHaveAttribute('href', '/app/jobs');
  });

  it('shows no actions when told to', () => {
    renderState(<ErrorState variant="403" actions={null} />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('offers a retry on 503 only when the screen can retry, and disables it while checking', () => {
    const retry = vi.fn();
    const { rerender } = renderState(<ErrorState variant="503" />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    rerender(<MemoryRouter><ErrorState variant="503" onRetry={retry} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(<MemoryRouter><ErrorState variant="503" onRetry={retry} checking /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Checking…');
  });

  it('keeps a 429 retry locked until Retry-After has passed', () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    renderState(<ErrorState variant="429" retryAfter={3} onRetry={retry} />);

    const button = screen.getByRole('button', { name: 'Retry now' });
    expect(button).toBeDisabled();
    expect(screen.getByText('3s')).toBeInTheDocument();

    for (let second = 0; second < 3; second += 1) act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('0s')).toBeInTheDocument();
    expect(screen.getByText('A slot may be free now.')).toBeInTheDocument();
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeDisabled();
  });

  it('offers a plain retry on a 429 that has no Retry-After', () => {
    const retry = vi.fn();
    renderState(<ErrorState variant="429" onRetry={retry} />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(retry).toHaveBeenCalled();
  });

  it('renders a free-form card for things that are not status codes', () => {
    renderState(<ErrorState status="OPTION_CLAMPED" tone="warning" code="warning, not an error" title="Smaller budget" actions={null}>Reduced.</ErrorState>);

    expect(screen.getByText('OPTION_CLAMPED')).toBeInTheDocument();
    expect(screen.getByText('warning, not an error')).toBeInTheDocument();
    expect(document.querySelector('.ui-state.is-warning')).not.toBeNull();
  });

  it('can stand alone as the whole page', () => {
    renderState(<ErrorState variant="404" layout="page" />);

    expect(document.querySelector('.ui-state.is-page')).not.toBeNull();
  });
});
