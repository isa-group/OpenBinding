import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, apiClient } from '../../api/client';
import { passwordStrength } from './passwordStrength';
import { PasswordResetCompletePage, PasswordResetRequestPage } from './PasswordReset';

const strictRequest = vi.spyOn(apiClient, 'request');

function problem(status: number, code?: string, message = 'refused') {
  const error = new HttpError(status, message);
  error.code = code;
  return error;
}

function Where() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname + location.search}</span>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/password-reset" element={<PasswordResetRequestPage />} />
        <Route path="/password-reset/complete" element={<PasswordResetCompletePage />} />
        <Route path="/login" element={<h1>Log in page</h1>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

describe('PasswordResetRequestPage', () => {
  // Braces matter: a function returned from beforeEach is run as the teardown.
  beforeEach(() => {
    strictRequest.mockReset();
  });

  it('asks for the email and posts it to the reset endpoint', async () => {
    strictRequest.mockResolvedValue({ accepted: true, delivery: 'email' });
    renderAt('/password-reset');

    expect(screen.getByRole('heading', { level: 1, name: 'Forgot your password?' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(strictRequest).toHaveBeenCalledWith(
      '/v1/auth/password-reset/request',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'ada@example.org' }) }),
      undefined, false, true,
    );
    expect(screen.getByText(/If an account exists for that email, we’ve sent it a one-time link/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });

  it('says where the instructions went when the deployment does not send email', async () => {
    strictRequest.mockResolvedValue({ accepted: true, delivery: 'operator' });
    renderAt('/password-reset');

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByText(/available to the operator of this deployment/)).toBeInTheDocument();
  });

  it('lets the person ask for another link', async () => {
    strictRequest.mockResolvedValue({ accepted: true, delivery: 'email' });
    renderAt('/password-reset');
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Send another link' }));

    expect(screen.getByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveValue('ada@example.org');
  });

  it('refuses an address that is not an email without calling the gateway', () => {
    renderAt('/password-reset');

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(strictRequest).not.toHaveBeenCalled();
    const field = screen.getByLabelText('Email address');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Enter a valid email address.');
    expect(field).toHaveFocus();
  });

  it('puts a 422 from the gateway on the email field', async () => {
    strictRequest.mockRejectedValue(problem(422));
    renderAt('/password-reset');

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() => expect(screen.getByLabelText('Email address')).toHaveAttribute('aria-invalid', 'true'));
  });

  it('reports an email outage as such', async () => {
    strictRequest.mockRejectedValue(problem(503));
    renderAt('/password-reset');

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('We can’t send email right now (503). Nothing was sent');
    expect(screen.getByLabelText('Email address')).toBeEnabled();
  });

  it('goes back to the log in page', () => {
    renderAt('/password-reset');

    expect(screen.getByRole('link', { name: 'Back to log in' })).toHaveAttribute('href', '/login');
  });
});

describe('PasswordResetCompletePage', () => {
  beforeEach(() => {
    strictRequest.mockReset();
  });

  const fill = (password: string, confirmation = password) => {
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirmation } });
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
  };

  it('explains that the page needs the token from the email when there is none', () => {
    renderAt('/password-reset/complete');

    expect(screen.getByRole('heading', { level: 1, name: 'This link is incomplete' })).toBeInTheDocument();
    expect(screen.getByText('Reset link · missing')).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/password-reset');
  });

  it('spends the token from the URL with the new password and then offers the log in', async () => {
    strictRequest.mockResolvedValue(undefined);
    renderAt('/password-reset/complete?token=obr_abc_def');

    expect(screen.getByRole('heading', { level: 1, name: 'Set a new password' })).toBeInTheDocument();
    expect(screen.getByText('Reset link · ready to use')).toBeInTheDocument();
    fill('a-long-enough-password');

    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(strictRequest).toHaveBeenCalledWith(
      '/v1/auth/password-reset/complete',
      expect.objectContaining({ body: JSON.stringify({ token: 'obr_abc_def', new_password: 'a-long-enough-password' }) }),
      undefined, false, true,
    );
    expect(screen.getByText('Reset link · used')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue to log in' })).toHaveAttribute('href', '/login');
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('takes the token out of the address as soon as the page has read it', async () => {
    strictRequest.mockResolvedValue(undefined);
    renderAt('/password-reset/complete?token=obr_abc_def&from=email');

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/password-reset/complete?from=email'));
    expect(screen.getByTestId('where')).not.toHaveTextContent('obr_abc_def');
    expect(screen.getByRole('heading', { level: 1, name: 'Set a new password' })).toBeInTheDocument();

    fill('a-long-enough-password');
    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(strictRequest).toHaveBeenCalledWith(
      '/v1/auth/password-reset/complete',
      expect.objectContaining({ body: JSON.stringify({ token: 'obr_abc_def', new_password: 'a-long-enough-password' }) }),
      undefined, false, true,
    );
  });

  it('checks length and confirmation before spending the token', () => {
    renderAt('/password-reset/complete?token=obr_abc_def');

    fill('short', 'different');

    expect(strictRequest).not.toHaveBeenCalled();
    expect(screen.getByLabelText('New password')).toHaveAccessibleDescription('Use at least 10 characters.');
    expect(screen.getByLabelText('New password')).toHaveFocus();
    expect(screen.getByLabelText('Confirm password')).toHaveAccessibleDescription('The passwords don’t match.');
  });

  it('asks for the confirmation to match even when the password is long enough', () => {
    renderAt('/password-reset/complete?token=obr_abc_def');

    fill('a-long-enough-password', 'a-long-enough-passwor');

    expect(strictRequest).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Confirm password')).toHaveFocus();
  });

  it('shows how strong the password is as it is typed', () => {
    renderAt('/password-reset/complete?token=obr_abc_def');
    const password = screen.getByLabelText('New password');

    expect(screen.getByText('Strength: Not set')).toBeInTheDocument();
    fireEvent.change(password, { target: { value: 'abc' } });
    expect(screen.getByText('Strength: Too short')).toBeInTheDocument();
    fireEvent.change(password, { target: { value: 'abcdefghijk' } });
    expect(screen.getByText('Strength: Good')).toBeInTheDocument();
    fireEvent.change(password, { target: { value: 'Abcdefghijk-1234' } });
    expect(screen.getByText('Strength: Strong')).toBeInTheDocument();
  });

  it('retires the form when the token is invalid, expired or used, and offers a new link', async () => {
    strictRequest.mockRejectedValue(problem(401, 'reset_token_invalid'));
    renderAt('/password-reset/complete?token=obr_abc_def');

    fill('a-long-enough-password');

    expect(await screen.findByRole('heading', { level: 1, name: 'This reset link can’t be used' })).toBeInTheDocument();
    expect(screen.getByText('Reset link · not accepted')).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toBeInTheDocument();
  });

  it('keeps the form and the token when the gateway calls the password too weak', async () => {
    strictRequest.mockRejectedValue(problem(422, 'weak_password', 'Password is on the common-passwords list.'));
    renderAt('/password-reset/complete?token=obr_abc_def');

    fill('password1234');

    expect(await screen.findByText('Password is on the common-passwords list.')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Reset link · ready to use')).toBeInTheDocument();
  });

  it('says the link is still valid when the gateway is unavailable', async () => {
    strictRequest.mockRejectedValue(problem(503));
    renderAt('/password-reset/complete?token=obr_abc_def');

    fill('a-long-enough-password');

    expect(await screen.findByRole('alert')).toHaveTextContent('Your link is still valid');
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
  });
});

describe('passwordStrength', () => {
  it('grades by length first and variety second', () => {
    expect(passwordStrength('')).toEqual({ level: 0, label: 'Not set' });
    expect(passwordStrength('ninechars')).toEqual({ level: 1, label: 'Too short' });
    expect(passwordStrength('tencharsok')).toEqual({ level: 2, label: 'Good' });
    expect(passwordStrength('lowercaseonlylonger')).toEqual({ level: 2, label: 'Good' });
    expect(passwordStrength('Mixed-Case-1234')).toEqual({ level: 3, label: 'Strong' });
  });
});
