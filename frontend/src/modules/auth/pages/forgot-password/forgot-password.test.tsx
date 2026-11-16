import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, apiClient } from '../../../../api/client';
import ForgotPasswordPage from '.';

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
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/authentication" element={<h1>Log in page</h1>} />
          <Route path="/forgot-password" element={<h1>Forgot page</h1>} />
        </Routes>
        <Where />
      </MemoryRouter>
    </HelmetProvider>
  );
}

describe('ForgotPasswordPage', () => {
  // Braces matter: a function returned from beforeEach is run as the teardown.
  beforeEach(() => {
    strictRequest.mockReset();
  });

  it('asks for the email and posts it to the reset endpoint', async () => {
    strictRequest.mockResolvedValue({ accepted: true, delivery: 'email' });
    renderAt('/forgot-password');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Forgot your password?' })
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'ada@example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(strictRequest).toHaveBeenCalledWith(
      '/v1/auth/password-reset/request',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'ada@example.org' }),
      }),
      undefined,
      false,
      true
    );
    expect(
      screen.getByText(/If an account exists for that email, we’ve sent it a one-time link/)
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });

  it('says where the instructions went when the deployment does not send email', async () => {
    strictRequest.mockResolvedValue({ accepted: true, delivery: 'operator' });
    renderAt('/forgot-password');

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'ada@example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(
      await screen.findByText(/available to the operator of this deployment/)
    ).toBeInTheDocument();
  });

  it('lets the person ask for another link', async () => {
    strictRequest.mockResolvedValue({ accepted: true, delivery: 'email' });
    renderAt('/forgot-password');
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'ada@example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Send another link' }));

    expect(screen.getByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveValue('ada@example.org');
  });

  it('refuses an address that is not an email without calling the gateway', () => {
    renderAt('/forgot-password');

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
    renderAt('/forgot-password');

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'ada@example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Email address')).toHaveAttribute('aria-invalid', 'true')
    );
  });

  it('reports an email outage as such', async () => {
    strictRequest.mockRejectedValue(problem(503));
    renderAt('/forgot-password');

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'ada@example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We can’t send email right now (503). Nothing was sent'
    );
    expect(screen.getByLabelText('Email address')).toBeEnabled();
  });

  it('goes back to the log in page', () => {
    renderAt('/forgot-password');

    expect(screen.getByRole('link', { name: 'Back to log in' })).toHaveAttribute(
      'href',
      '/authentication'
    );
  });
});
