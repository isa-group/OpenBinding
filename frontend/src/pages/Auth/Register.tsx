import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/auth';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { HttpError } from '../../api/client';
import './Auth.css';

/** Matches the gateway's own rule, so the refusal happens before the round trip. */
const MIN_PASSWORD_LENGTH = 10;

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
      return;
    }

    setBusy(true);
    try {
      await register({ username, email, password });
      navigate('/account', { replace: true, viewTransition: true });
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        setError('That username or email is already in use.');
      } else if (err instanceof HttpError && err.status === 422) {
        setError('That password is not acceptable. Try a longer one.');
      } else {
        setError('The account could not be created. Try again in a moment.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <Card padding="lg" className="auth-card">
        <div className="auth-header">
          <span className="auth-kicker">Account contract</span>
          <h1>Create an account</h1>
          <p>
            Free, and immediate. New accounts start on the Free plan, with a monthly
            allowance of solver time you can see on your account page.
          </p>
        </div>

        {error && <Alert type="error">{error}</Alert>}

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,63}"
              title="Letters, digits, dot, underscore or hyphen; 3 to 64 characters."
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>

          <div className="auth-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <span className="auth-hint">You can sign in with either this or your username.</span>
          </div>

          <div className="auth-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <span className="auth-hint">
              At least {MIN_PASSWORD_LENGTH} characters. Length is the only rule.
            </span>
          </div>

          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </form>

        <p className="auth-footer">
          Already have one? <Link to="/login" viewTransition>Sign in</Link>.
        </p>
      </Card>
    </div>
  );
}
