import { fireEvent, render, screen } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, apiClient } from '../../../../api/client';
import ResetPasswordPage from '.';

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
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/authentication" element={<h1>Log in page</h1>} />
          <Route path="/forgot-password" element={<h1>Forgot page</h1>} />
        </Routes>
        <Where />
      </MemoryRouter>
    </HelmetProvider>
  );
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    strictRequest.mockReset();
  });

  const fill = (password: string, confirmation = password) => {
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: confirmation },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
  };

  it.each(['/reset-password', '/reset-password?token='])(
    'explains that %s has no token and offers a new link',
    address => {
      renderAt(address);

      expect(
        screen.getByRole('heading', { level: 1, name: 'This reset link can’t be used' })
      ).toBeInTheDocument();
      expect(screen.getByText('Reset link · missing')).toBeInTheDocument();
      expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
        'href',
        '/forgot-password'
      );
      expect(strictRequest).not.toHaveBeenCalled();
    }
  );

  it('shows the new-password form for a token', () => {
    renderAt('/reset-password?token=abc123');

    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to log in' })).toHaveAttribute(
      'href',
      '/authentication'
    );
  });

  it('spends the token from the URL with the new password and then offers the log in', async () => {
    strictRequest.mockResolvedValue(undefined);
    renderAt('/reset-password?token=obr_abc_def');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Set a new password' })
    ).toBeInTheDocument();
    expect(screen.getByText('Reset link · ready to use')).toBeInTheDocument();
    fill('a-long-enough-password');

    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(strictRequest).toHaveBeenCalledWith(
      '/v1/auth/password-reset/complete',
      expect.objectContaining({
        body: JSON.stringify({ token: 'obr_abc_def', new_password: 'a-long-enough-password' }),
      }),
      undefined,
      false,
      true
    );
    expect(screen.getByText('Reset link · used')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue to log in' })).toHaveAttribute(
      'href',
      '/authentication'
    );
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('goes on to the log in page once the password is changed', async () => {
    strictRequest.mockResolvedValue(undefined);
    renderAt('/reset-password?token=obr_abc_def');
    fill('a-long-enough-password');

    fireEvent.click(await screen.findByRole('link', { name: 'Continue to log in' }));

    expect(screen.getByRole('heading', { name: 'Log in page' })).toBeInTheDocument();
  });

  it('keeps the token in the address and spends it', async () => {
    strictRequest.mockResolvedValue(undefined);
    renderAt('/reset-password?token=obr_abc_def&from=email');

    expect(screen.getByTestId('where')).toHaveTextContent(
      '/reset-password?token=obr_abc_def&from=email'
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Set a new password' })
    ).toBeInTheDocument();

    fill('a-long-enough-password');
    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(strictRequest).toHaveBeenCalledWith(
      '/v1/auth/password-reset/complete',
      expect.objectContaining({
        body: JSON.stringify({ token: 'obr_abc_def', new_password: 'a-long-enough-password' }),
      }),
      undefined,
      false,
      true
    );
  });

  it('checks length and confirmation before spending the token', () => {
    renderAt('/reset-password?token=obr_abc_def');

    fill('short', 'different');

    expect(strictRequest).not.toHaveBeenCalled();
    expect(screen.getByLabelText('New password')).toHaveAccessibleDescription(
      'Use at least 10 characters.'
    );
    expect(screen.getByLabelText('New password')).toHaveFocus();
    expect(screen.getByLabelText('Confirm password')).toHaveAccessibleDescription(
      'The passwords don’t match.'
    );
  });

  it('asks for the confirmation to match even when the password is long enough', () => {
    renderAt('/reset-password?token=obr_abc_def');

    fill('a-long-enough-password', 'a-long-enough-passwor');

    expect(strictRequest).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Confirm password')).toHaveFocus();
  });

  it('shows how strong the password is as it is typed', () => {
    renderAt('/reset-password?token=obr_abc_def');
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
    renderAt('/reset-password?token=obr_abc_def');

    fill('a-long-enough-password');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'This reset link can’t be used' })
    ).toBeInTheDocument();
    expect(screen.getByText('Reset link · not accepted')).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot-password'
    );
  });

  it('keeps the form and the token when the gateway calls the password too weak', async () => {
    strictRequest.mockRejectedValue(
      problem(422, 'weak_password', 'Password is on the common-passwords list.')
    );
    renderAt('/reset-password?token=obr_abc_def');

    fill('password1234');

    expect(
      await screen.findByText('Password is on the common-passwords list.')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Reset link · ready to use')).toBeInTheDocument();
  });

  it('says the link is still valid when the gateway is unavailable', async () => {
    strictRequest.mockRejectedValue(problem(503));
    renderAt('/reset-password?token=obr_abc_def');

    fill('a-long-enough-password');

    expect(await screen.findByRole('alert')).toHaveTextContent('Your link is still valid');
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
  });
});
