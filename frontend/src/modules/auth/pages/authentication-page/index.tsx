// Adapted from SPHERE frontend/src/modules/auth/pages/authentication-page/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: no SCORE Identity redirect (it arrives in F5); a page title per view.

import { Helmet } from 'react-helmet-async';
import { useSearchParams } from 'react-router-dom';
import AuthLayout from '../../components/auth-layout';
import LoginForm from '../../components/login-form';
import RegisterForm from '../../components/register-form';

/** `/authentication`: the login form, or the registration form with `?view=register`. */
export default function AuthenticationPage() {
  const [searchParams] = useSearchParams();
  const register = searchParams.get('view') === 'register';

  return (
    <AuthLayout>
      <Helmet>
        <title>{register ? 'OpenBinding - Create an account' : 'OpenBinding - Log in'}</title>
      </Helmet>
      {register ? <RegisterForm /> : <LoginForm />}
    </AuthLayout>
  );
}
