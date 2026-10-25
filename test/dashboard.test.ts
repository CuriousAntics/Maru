import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { createDashboardHandler } from '../src/dashboard.js';
import { cookie, dashboardConfig, digest, logoutProof, randomToken } from '../src/web-security.js';

const db = new PGlite();
const guild = '100000000000000001';
const user = '300000000000000001';
const adminRole = '200000000000000001';
const modRole = '200000000000000002';
const pool = { async query(sql: string, values?: unknown[]) {
  const result = await db.query(sql, values);
  return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
} } as unknown as Pool;
let base = '';
let roles: string[] | null;
let memberFailure = false;
let exchangeFailure = false;
let exchanges = 0;
let displayName = 'Miranda';
const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith('/oauth2/token/revoke')) return new Response('{}');
  if (String(url).endsWith('/oauth2/token')) {
    exchanges++;
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get('redirect_uri'), `${base}/auth/discord/callback`);
    assert.equal(form.get('grant_type'), 'authorization_code');
    return exchangeFailure ? new Response('{}', { status: 400 })
      : Response.json({ access_token: 'temporary-test-token', token_type: 'Bearer' });
  }
  assert.equal(String(url), 'https://discord.com/api/v10/users/@me');
  return Response.json({ id: user, username: 'test-staff', global_name: displayName });
}) as typeof fetch;

function makeHandler(configured = true) {
  return createDashboardHandler({
    pool, guildId: guild,
    config: configured ? { origin: base, secure: false, applicationId: '400000000000000001', clientSecret: 'test-only' } : undefined,
    isBotReady: () => true,
    readMemberRoles: async () => { if (memberFailure) throw new Error('Discord unavailable'); return roles; },
    fetcher,
  });
}
let handler: ReturnType<typeof makeHandler>;
const server = createServer((request, response) => { void handler(request, response); });

before(async () => {
  for (const name of ['001_foundation.sql', '002_dashboard_auth.sql']) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    await db.exec(sql.replace(/^\uFEFF/, ''));
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  roles = [adminRole]; memberFailure = false; exchangeFailure = false; exchanges = 0; displayName = 'Miranda';
  await db.exec('TRUNCATE dashboard_login_attempts, dashboard_sessions, audit_events, staff_access_grants, staff_roles, guild_settings RESTART IDENTITY');
  await pool.query('INSERT INTO guild_settings (guild_id) VALUES ($1)', [guild]);
  await pool.query(`INSERT INTO staff_roles (guild_id, role_id, access_level)
    VALUES ($1, $2, 'admin'), ($1, $3, 'moderator')`, [guild, adminRole, modRole]);
  handler = makeHandler();
});
after(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  await db.close();
});

async function request(path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, redirect: 'manual' });
}
async function begin() {
  const response = await request('/auth/discord');
  assert.equal(response.status, 303);
  const auth = new URL(response.headers.get('location')!);
  return { state: auth.searchParams.get('state')!, cookie: response.headers.getSetCookie()[0]!.split(';')[0]!, auth };
}
async function complete(start: Awaited<ReturnType<typeof begin>>, suffix = '') {
  return request(`/auth/discord/callback?code=test-code&state=${start.state}&iss=https%3A%2F%2Fdiscord.com${suffix}`, {
    headers: { cookie: start.cookie },
  });
}
async function signIn() {
  const response = await complete(await begin());
  assert.equal(response.status, 303);
  const session = response.headers.getSetCookie().find((value) => value.startsWith('maru_session=') && !value.startsWith('maru_session=;'))!;
  assert.ok(session);
  return session.split(';')[0]!;
}
async function rowCount(table: 'dashboard_sessions' | 'dashboard_login_attempts') {
  const result = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
  return result.rows[0]!.count;
}

test('public landing shows a sign-in link without audit data', async () => {
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Continue with Discord/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
});
test('dashboard requires authentication', async () => {
  const response = await request('/dashboard');
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
});
test('login asks only for identify and stores hashed browser tokens', async () => {
  const start = await begin();
  assert.equal(start.auth.origin, 'https://discord.com');
  assert.equal(start.auth.searchParams.get('scope'), 'identify');
  assert.equal(start.auth.searchParams.get('redirect_uri'), `${base}/auth/discord/callback`);
  const result = await db.query<{ token_hash: string; state_hash: string }>('SELECT token_hash, state_hash FROM dashboard_login_attempts');
  assert.equal(result.rows[0]!.token_hash, digest(start.cookie.split('=')[1]!));
  assert.notEqual(result.rows[0]!.state_hash, start.state);
});
test('callback without its browser cookie is rejected before token exchange', async () => {
  const start = await begin();
  const response = await request(`/auth/discord/callback?code=x&state=${start.state}`);
  assert.equal(response.status, 400);
  assert.equal(exchanges, 0);
});
test('mismatched state is rejected before token exchange', async () => {
  const start = await begin();
  const response = await request(`/auth/discord/callback?code=x&state=${randomToken()}`, { headers: { cookie: start.cookie } });
  assert.equal(response.status, 400);
  assert.equal(exchanges, 0);
});
test('expired login attempt is rejected', async () => {
  const start = await begin();
  await db.exec("UPDATE dashboard_login_attempts SET expires_at = NOW() - INTERVAL '1 minute'");
  assert.equal((await complete(start)).status, 400);
  assert.equal(exchanges, 0);
});
test('callback state is single-use', async () => {
  const start = await begin();
  assert.equal((await complete(start)).status, 303);
  assert.equal((await complete(start)).status, 400);
  assert.equal(exchanges, 1);
});
test('wrong issuer is rejected', async () => {
  const start = await begin();
  const response = await request(`/auth/discord/callback?code=x&state=${start.state}&iss=https://invalid.example`, {
    headers: { cookie: start.cookie },
  });
  assert.equal(response.status, 400);
  assert.equal(exchanges, 0);
});
test('duplicate state parameters are rejected', async () => {
  const start = await begin();
  assert.equal((await complete(start, `&state=${start.state}`)).status, 400);
  assert.equal(exchanges, 0);
});
test('OAuth cancellation consumes the sign-in attempt without creating a session', async () => {
  const start = await begin();
  const response = await request(`/auth/discord/callback?error=access_denied&state=${start.state}`, { headers: { cookie: start.cookie } });
  assert.equal(response.status, 400);
  assert.equal(await rowCount('dashboard_sessions'), 0);
  assert.equal(await rowCount('dashboard_login_attempts'), 0);
});
test('failed OAuth exchange creates no session', async () => {
  exchangeFailure = true;
  assert.equal((await complete(await begin())).status, 503);
  assert.equal(await rowCount('dashboard_sessions'), 0);
});
test('nonstaff member cannot sign in', async () => {
  roles = [];
  assert.equal((await complete(await begin())).status, 403);
  assert.equal(await rowCount('dashboard_sessions'), 0);
});
test('nonmember cannot sign in', async () => {
  roles = null;
  assert.equal((await complete(await begin())).status, 403);
});
test('Discord membership failures fail closed', async () => {
  memberFailure = true;
  assert.equal((await complete(await begin())).status, 503);
  assert.equal(await rowCount('dashboard_sessions'), 0);
});
test('Admin sees dashboard and session tokens are stored only as hashes', async () => {
  const session = await signIn();
  const response = await request('/dashboard', { headers: { cookie: session } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /class="value">Admin/);
  const result = await db.query<{ token_hash: string }>('SELECT token_hash FROM dashboard_sessions');
  assert.equal(result.rows[0]!.token_hash, digest(session.split('=')[1]!));
});
test('Mod sees Moderator access', async () => {
  roles = [modRole];
  const response = await request('/dashboard', { headers: { cookie: await signIn() } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /class="value">Moderator/);
});
test('grant revocation is reflected on the next dashboard request', async () => {
  roles = [modRole];
  await pool.query('INSERT INTO staff_access_grants (guild_id, user_id, granted_by) VALUES ($1,$2,$3)', [guild, user, user]);
  const session = await signIn();
  await pool.query('DELETE FROM staff_access_grants WHERE user_id = $1', [user]);
  const response = await request('/dashboard', { headers: { cookie: session } });
  assert.match(await response.text(), /class="value">Moderator/);
});
test('loss of staff roles invalidates the session', async () => {
  const session = await signIn();
  roles = [];
  assert.equal((await request('/dashboard', { headers: { cookie: session } })).status, 403);
  assert.equal(await rowCount('dashboard_sessions'), 0);
});
test('expired sessions cannot access audit data', async () => {
  const session = await signIn();
  await db.exec("UPDATE dashboard_sessions SET expires_at = NOW() - INTERVAL '1 minute'");
  assert.equal((await request('/dashboard', { headers: { cookie: session } })).status, 303);
});
test('server restart preserves database-backed sessions', async () => {
  const session = await signIn();
  handler = makeHandler();
  assert.equal((await request('/dashboard', { headers: { cookie: session } })).status, 200);
});
test('profile names and audit reasons are HTML escaped and other servers are excluded', async () => {
  displayName = '<script>profile</script>';
  await pool.query(`INSERT INTO audit_events (guild_id, actor_id, event_type, details)
    VALUES ($1, $2, 'TEST', $3::jsonb)`, [guild, user, JSON.stringify({ reason: '<img src=x onerror=alert(1)>' })]);
  await pool.query('INSERT INTO guild_settings (guild_id) VALUES ($1)', ['100000000000000002']);
  await pool.query(`INSERT INTO audit_events (guild_id, actor_id, event_type)
    VALUES ($1, $2, 'OTHER_SERVER_SECRET')`, ['100000000000000002', user]);
  const response = await request('/dashboard', { headers: { cookie: await signIn() } });
  const body = await response.text();
  assert.ok(body.includes('&lt;script&gt;profile&lt;/script&gt;'));
  assert.ok(body.includes('&lt;img'));
  assert.ok(!body.includes('<script>profile'));
  assert.ok(!body.includes('OTHER_SERVER_SECRET'));
});
test('logout requires POST and rejects cross-site requests', async () => {
  const session = await signIn();
  assert.equal((await request('/auth/logout', { headers: { cookie: session } })).status, 405);
  const response = await request('/auth/logout', { method: 'POST', headers: {
    cookie: session, origin: 'https://invalid.example', 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ csrf: logoutProof(session.split('=')[1]!) }) });
  assert.equal(response.status, 403);
  assert.equal(await rowCount('dashboard_sessions'), 1);
});
test('logout rejects an invalid CSRF proof', async () => {
  const session = await signIn();
  const response = await request('/auth/logout', { method: 'POST', headers: {
    cookie: session, origin: base, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ csrf: 'wrong' }) });
  assert.equal(response.status, 403);
  assert.equal(await rowCount('dashboard_sessions'), 1);
});
test('logout deletes the server-side session', async () => {
  const session = await signIn();
  const response = await request('/auth/logout', { method: 'POST', headers: {
    cookie: session, origin: base, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ csrf: logoutProof(session.split('=')[1]!) }) });
  assert.equal(response.status, 303);
  assert.equal(await rowCount('dashboard_sessions'), 0);
  assert.equal((await request('/dashboard', { headers: { cookie: session } })).status, 303);
});
test('second sign-in rotates the session and removes the old session', async () => {
  const old = await signIn();
  const start = await begin();
  const response = await request(`/auth/discord/callback?code=x&state=${start.state}`, {
    headers: { cookie: `${start.cookie}; ${old}` },
  });
  assert.equal(response.status, 303);
  assert.equal(await rowCount('dashboard_sessions'), 1);
  assert.equal((await request('/dashboard', { headers: { cookie: old } })).status, 303);
});
test('dashboard remains disabled until all sign-in variables are configured', async () => {
  handler = makeHandler(false);
  assert.equal((await request('/')).status, 503);
});
test('production cookies and base URL validation enforce HTTPS', () => {
  const header = cookie('__Host-maru_session', randomToken(), 28800, true);
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/); assert.match(header, /; Secure/);
  const env = { APP_BASE_URL: 'http://public.example', DISCORD_APPLICATION_ID: '400000000000000001', DISCORD_CLIENT_SECRET: 'test' };
  assert.throws(() => dashboardConfig(env));
  assert.throws(() => dashboardConfig({ ...env, APP_BASE_URL: 'https://public.example/extra' }));
  assert.equal(dashboardConfig({ ...env, APP_BASE_URL: 'https://public.example' })?.secure, true);
  assert.equal(dashboardConfig({}), undefined);
});
