// Adapted from SPHERE frontend/src/modules/auth/pages/authentication-page/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a page title per view; in SCORETech mode one sign-in for logging in and signing up (SCORETech Identity registers an
// unknown email from its sign-in page).

import { Helmet } from 'react-helmet-async';
import { useSearchParams } from 'react-router-dom';
import { IdentityRedirect } from '../../components/identity-redirect';
import { useAuthConfig } from '../../contexts/authConfigContext';
import AuthLayout from '../../components/auth-layout';
import LoginForm from '../../components/login-form';
import RegisterForm from '../../components/register-form';

/**
 * `/authentication`: in SCORETech mode the way to SCORETech Identity (one button, no form); in local mode the login form, or
 * the registration form with `?view=register`.
 */
export default function AuthenticationPage() {
  const [searchParams] = useSearchParams();
  const register = searchParams.get('view') === 'register';
  const identity = useAuthConfig().provider === 'scoretech';

  if (identity) return <IdentityRedirect />;

  return (
    <AuthLayout>
      <Helmet>
        <title>{register ? 'OpenBinding - Create an account' : 'OpenBinding - Log in'}</title>
      </Helmet>
      {register ? <RegisterForm /> : <LoginForm />}
    </AuthLayout>
  );
}
