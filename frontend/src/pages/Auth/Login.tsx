import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { apiClient } from '../../api/client';
import { useAuth } from '../../contexts/auth';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import './Auth.css';

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notice = (location.state as { notice?: string } | null)?.notice;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(identifier, password);
      // Back to whatever they were trying to reach, or the account page.
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/account', { replace: true, viewTransition: true });
    } catch {
      // The gateway answers the same way for a wrong password and an account
      // that does not exist, and so does this: saying which would tell an
      // unauthenticated visitor who has an account here.
      setError('Those credentials do not match an active account.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <Card padding="lg" className="auth-card">
        <div className="auth-header">
          <span className="auth-kicker">Gateway access</span>
          <h1>Sign in</h1>
          <p>Solving needs an account. Analysing and browsing the schemas do not.</p>
        </div>

        {error && <Alert type="error">{error}</Alert>}
        {notice && <Alert type="success">{notice}</Alert>}

        <a className="auth-cas-action" href={apiClient.casStartUrl()}>
          <Building2 aria-hidden="true" />
          <span><strong>Continue with Universidad de Sevilla</strong><small>Verified UVUS access · RESEARCH plan</small></span>
        </a>

        <div className="auth-divider"><span>or use your OpenBinding account</span></div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="identifier">Username or email</label>
            <input
              id="identifier"
              name="identifier"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <Button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="auth-footer">
          <Link to="/password-reset" viewTransition>Forgot your password?</Link>
          <span>No account? <Link to="/register" viewTransition>Create one</Link>.</span>
        </p>
      </Card>
    </div>
  );
}

export function CasCallback() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const started = useRef(false);
  const code = new URLSearchParams(location.search).get('code');
  const [error, setError] = useState<string | null>(() => code
    ? null
    : 'The institutional sign-in response did not include an exchange code.');

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!code) return;
    void apiClient.exchangeCasCode(code)
      .then(refresh)
      .then(() => navigate('/app', { replace: true, viewTransition: true }))
      .catch(() => setError('The institutional sign-in code expired or was already used. Start again.'));
  }, [code, navigate, refresh]);

  return <div className="auth-page"><Card padding="lg" className="auth-card auth-status-card">
    <span className="auth-kicker">Institutional access</span>
    <h1>{error ? 'Sign-in stopped' : 'Verifying identity'}</h1>
    {error ? <><Alert type="error">{error}</Alert><Link className="auth-return" to="/login">Return to sign in</Link></> : <p role="status">Exchanging the one-time US identity code…</p>}
  </Card></div>;
}

export function PasswordResetRequestPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.requestPasswordReset(email);
      setDelivery(result.delivery === 'email'
        ? 'If that address belongs to an account, a reset link is on its way.'
        : 'If that address belongs to an account, reset instructions are now available to the operator.');
    } catch {
      setError('Password reset is unavailable right now. Try again later.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="auth-page"><Card padding="lg" className="auth-card">
    <div className="auth-header"><span className="auth-kicker">Account recovery</span><h1>Reset access</h1><p>We never reveal whether an email address has an account.</p></div>
    {delivery && <Alert type="success">{delivery}</Alert>}
    {error && <Alert type="error">{error}</Alert>}
    <form className="auth-form" onSubmit={submit}>
      <div className="auth-field"><label htmlFor="reset-email">Email</label><input id="reset-email" name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
      <Button type="submit" disabled={busy}>{busy ? 'Requesting…' : 'Request reset'}</Button>
    </form>
    <p className="auth-footer"><Link to="/login" viewTransition>Return to sign in</Link></p>
  </Card></div>;
}

export function PasswordResetCompletePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This reset link does not contain a token.');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.completePasswordReset(token, password);
      navigate('/login', { replace: true, state: { notice: 'Password changed. Sign in with the new password.' }, viewTransition: true });
    } catch {
      setError('This reset link is invalid, expired or already used. Request a new one.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="auth-page"><Card padding="lg" className="auth-card">
    <div className="auth-header"><span className="auth-kicker">One-time reset</span><h1>Choose a password</h1><p>The reset token is spent as soon as this change succeeds.</p></div>
    {error && <Alert type="error">{error}</Alert>}
    <form className="auth-form" onSubmit={submit}>
      <div className="auth-field"><label htmlFor="reset-password">New password</label><input id="reset-password" name="password" type="password" minLength={10} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
      <Button type="submit" disabled={busy || !token}>{busy ? 'Changing…' : 'Change password'}</Button>
    </form>
    <p className="auth-footer"><Link to="/password-reset" viewTransition>Request another link</Link></p>
  </Card></div>;
}
