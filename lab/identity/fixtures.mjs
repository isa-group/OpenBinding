// Fixtures of the OpenBinding Identity walk, run inside the SCORETech Identity lab's account-api container:
//
//   docker exec -i <account-api> node --input-type=module -   (this script on stdin, preceded by `const REQUEST = {...};`)
//
// REQUEST = {action: create|inspect|grant|claims|delete, run, origin, secret?, adminUser, adminPassword, users?, email?}.
// The lab's bootstrap administrator password and the client secret arrive in REQUEST only; nothing secret is printed.
// The script prints one JSON line of ids, subjects, booleans and claim names: never a token, a secret or a code.
//
// The client mirrors a SCORETech Identity managed application (ApplicationsResourceFactory.java at 215dffe): confidential,
// standard flow with PKCE S256 only, exact redirect URI, no full scope, the scope mapping of `openbinding:access`, the
// default client scopes `profile` and `email` only, and exactly the four mappers a managed application gets. The users have
// first and last names (Identity diverts a code sign-in without a first name to its registration form) and the attributes
// Identity reads display names and avatars from. Adapted from SPHERE's recipe (api/src/test/e2e/scoretech-identity.browser.ts).
/* global REQUEST */
const base = 'http://keycloak:8080/identity/auth';
const realm = `${base}/admin/realms/score`;
const PERMISSION = 'openbinding:access';
const OWNED = 'score-access-rule-';

const login = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: REQUEST.adminUser,
    password: REQUEST.adminPassword,
  }),
});
if (!login.ok) throw Error(`fixture login failed (${login.status})`);
const { access_token: token } = await login.json();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function call(path, method = 'GET', body) {
  const response = await fetch(realm + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw Error(`fixture ${method} ${path.split('?')[0]} failed (${response.status})`);
  if (response.status === 201) return response.headers.get('location')?.split('/').pop() ?? null;
  return response.status === 204 ? null : response.json();
}

const clientId = `ob-walk-${REQUEST.run}`;
const out = { action: REQUEST.action, clientId };

async function role() {
  let found = await call(`/roles/${encodeURIComponent(PERMISSION)}`);
  if (!found) {
    await call('/roles', 'POST', { name: PERMISSION, description: 'Use OpenBinding (walk fixture)' });
    found = await call(`/roles/${encodeURIComponent(PERMISSION)}`);
  }
  return found;
}

async function clientOf(id) {
  const rows = (await call(`/clients?clientId=${encodeURIComponent(id)}`)) ?? [];
  return rows.find((row) => row.clientId === id) ?? null;
}

async function userOf(email) {
  const rows = (await call(`/users?email=${encodeURIComponent(email)}&exact=true`)) ?? [];
  return rows.find((row) => (row.email ?? '').toLowerCase() === email.toLowerCase()) ?? null;
}

if (REQUEST.action === 'create') {
  const permission = await role();
  const callback = `${REQUEST.origin}/api/v1/auth/identity/callback`;
  const id = await call('/clients', 'POST', {
    clientId,
    name: `OpenBinding walk ${REQUEST.run}`,
    enabled: true,
    protocol: 'openid-connect',
    publicClient: false,
    clientAuthenticatorType: 'client-secret',
    secret: REQUEST.secret,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    consentRequired: false,
    fullScopeAllowed: false,
    redirectUris: [callback],
    webOrigins: [REQUEST.origin],
    defaultClientScopes: ['profile', 'email'],
    optionalClientScopes: [],
    attributes: {
      'pkce.code.challenge.method': 'S256',
      'access.token.lifespan': '60',
      'post.logout.redirect.uris': `${REQUEST.origin}/`,
      'scoretech.shared-user-fields': JSON.stringify(['avatar', 'display_name', 'email', 'name']),
    },
    protocolMappers: [
      { name: `${OWNED}authentication-policy`, protocol: 'openid-connect', protocolMapper: 'tentu-authentication-policy', config: {} },
      {
        name: `${OWNED}realm-roles`,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-realm-role-mapper',
        config: { 'access.token.claim': 'true', 'claim.name': 'realm_access.roles', 'jsonType.label': 'String', multivalued: 'true' },
      },
      {
        name: `${OWNED}client-audience`,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: { 'included.custom.audience': clientId, 'access.token.claim': 'true', 'id.token.claim': 'false' },
      },
      {
        name: 'score-application-subject',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-sub-mapper',
        config: { 'access.token.claim': 'true', 'introspection.token.claim': 'true' },
      },
    ],
  });
  // Exactly `profile` and `email`, whatever the realm's defaults added.
  for (const kind of ['default', 'optional']) {
    for (const scope of (await call(`/clients/${id}/${kind}-client-scopes`)) ?? []) {
      if (kind === 'optional' || !['profile', 'email'].includes(scope.name)) {
        await call(`/clients/${id}/${kind}-client-scopes/${scope.id}`, 'DELETE');
      }
    }
  }
  await call(`/clients/${id}/scope-mappings/realm`, 'POST', [permission]);
  out.client = id;
  out.users = {};
  for (const user of REQUEST.users) {
    const attributes = { scoreProfile: [JSON.stringify({ displayName: user.displayName })] };
    if (user.avatar) attributes.tentuAvatar = [JSON.stringify(user.avatar)];
    const userId = await call('/users', 'POST', {
      username: user.email,
      email: user.email,
      emailVerified: user.emailVerified,
      firstName: 'Walk',
      lastName: user.role,
      enabled: true,
      attributes,
    });
    if (user.permission) await call(`/users/${userId}/role-mappings/realm`, 'POST', [permission]);
    out.users[user.role] = { id: userId, sub: userId };
  }
} else if (REQUEST.action === 'inspect') {
  const user = await userOf(REQUEST.email);
  out.found = Boolean(user);
  out.emailVerified = user?.emailVerified === true;
  out.id = user?.id ?? null;
} else if (REQUEST.action === 'grant') {
  const user = await userOf(REQUEST.email);
  if (!user) throw Error('no such fixture user');
  await call(`/users/${user.id}/role-mappings/realm`, 'POST', [await role()]);
  out.granted = true;
} else if (REQUEST.action === 'claims') {
  const client = await clientOf(clientId);
  const user = await userOf(REQUEST.email);
  if (!client || !user) throw Error('no fixture client or user');
  const query = `?scope=${encodeURIComponent('openid profile email')}&userId=${user.id}`;
  const idToken = await call(`/clients/${client.id}/evaluate-scopes/generate-example-id-token${query}`);
  const accessToken = await call(`/clients/${client.id}/evaluate-scopes/generate-example-access-token${query}`);
  out.idToken = Object.keys(idToken ?? {}).sort();
  out.accessToken = Object.keys(accessToken ?? {}).sort();
} else if (REQUEST.action === 'delete') {
  out.deleted = [];
  for (const email of REQUEST.emails) {
    const user = await userOf(email);
    if (user && (user.email ?? '').toLowerCase() === email.toLowerCase()) {
      await call(`/users/${user.id}`, 'DELETE');
      out.deleted.push(user.id);
    }
  }
  const client = await clientOf(clientId);
  if (client && client.clientId === clientId) {
    await call(`/clients/${client.id}`, 'DELETE');
    out.deleted.push(client.id);
  }
} else {
  throw Error(`unknown action ${REQUEST.action}`);
}
console.log(JSON.stringify(out));
