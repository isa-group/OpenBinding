import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
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
          No account? <Link to="/register" viewTransition>Create one</Link>.
        </p>
      </Card>
    </div>
  );
}
