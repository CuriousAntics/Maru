import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { createDashboardHandler } from '../src/dashboard.js';
import { cookie, dashboardConfig, digest, logoutProof, settingsProof, testLogProof, randomToken } from '../src/web-security.js';

const db = new PGlite();
const guild = '100000000000000001';
const user = '300000000000000001';
const adminRole = '200000000000000001';
const modRole = '200000000000000002';
let failSettingsAudit = false;
let failTestAudit: 'request' | 'result' | undefined;
async function query(sql: string, values?: unknown[]) {
  if (failSettingsAudit && sql.includes("'SERVER_SETTINGS_CHANGED'")) throw new Error('test audit write failure');
  if (failTestAudit === 'request' && sql.includes("'TEST_LOG_REQUESTED',")) throw new Error('test request audit failure');
  if (failTestAudit === 'result' && values?.[2] && String(values[2]).startsWith('TEST_LOG_')) throw new Error('test result audit failure');
  const result = await db.query(sql, values);
  return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
}
const pool = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
let base = '';
let roles: string[] | null;
let memberFailure = false;
let botReady = true;
let memberReadHook: (() => Promise<void>) | undefined;
let exchangeFailure = false;
let exchanges = 0;
let displayName = 'Miranda';
const channelId = '500000000000000001';
const secondChannel = '500000000000000002';
let channels = [{ id: channelId, name: 'logs', usable: true }, { id: secondChannel, name: 'staff-logs', usable: true }];
let channelFailure = false;
let sendFailure: 'network' | 'forbidden' | 'invalid' | undefined;
let sends: { channelId: string; body: RESTPostAPIChannelMessageJSONBody }[] = [];
const messageId = '600000000000000001';
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
    isBotReady: () => botReady,
    readMemberRoles: async () => { await memberReadHook?.(); if (memberFailure) throw new Error('Discord unavailable'); return roles; },
    readLogChannels: async () => { if (channelFailure) throw new Error('channel lookup failed'); return channels; },
    sendTestMessage: async (destination, body) => {
      sends.push({ channelId: destination, body });
      if (sendFailure === 'network') throw new Error('private network diagnostic');
      if (sendFailure === 'forbidden') throw Object.assign(new Error('private Discord detail'), { status: 403 });
      return { id: sendFailure === 'invalid' ? 'invalid' : messageId, channel_id: destination };
    },
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
  failSettingsAudit = false; channelFailure = false; memberReadHook = undefined;
  failTestAudit = undefined; sendFailure = undefined; sends = []; botReady = true;
  channels = [{ id: channelId, name: 'logs', usable: true }, { id: secondChannel, name: 'staff-logs', usable: true }];
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

async function saveSettings(session: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return request('/settings', { method: 'POST', headers: {
    cookie: session, origin: base, 'Content-Type': 'application/x-www-form-urlencoded', ...headers,
  }, body: new URLSearchParams({ csrf: settingsProof(session.split('=')[1]!), channel_id: channelId,
    previous_channel_id: '', reason: 'Use the staff log channel', ...fields }) });
}
async function savedSettings() {
  const result = await db.query<{ settings: Record<string, unknown> }>('SELECT settings FROM guild_settings WHERE guild_id = $1', [guild]);
  return result.rows[0]!.settings;
}
async function settingsAudits() {
  const result = await db.query<{ actor_id: string; details: Record<string, unknown> }>(
    "SELECT actor_id, details FROM audit_events WHERE event_type = 'SERVER_SETTINGS_CHANGED' ORDER BY event_id");
  return result.rows;
}

test('settings page requires authentication', async () => {
  assert.equal((await request('/settings')).status, 303);
  assert.equal((await request('/settings', { method: 'POST' })).status, 303);
});
test('Admin can choose channels and needs a reason', async () => {
  const response = await request('/settings', { headers: { cookie: await signIn() } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.match(body, /#logs/); assert.match(body, /Save settings/); assert.match(body, /name="reason" required/);
  assert.match(body, /Automatic moderation logs are not active yet/);
});
test('ordinary Mod sees settings but cannot submit changes', async () => {
  roles = [modRole];
  const session = await signIn();
  const body = await (await request('/settings', { headers: { cookie: session } })).text();
  assert.ok(!body.includes('Save settings'));
  assert.equal((await saveSettings(session)).status, 403);
  assert.deepEqual(await savedSettings(), {}); assert.equal((await settingsAudits()).length, 0);
});
test('Admin saves settings and audit together while preserving other settings and servers', async () => {
  const otherGuild = '100000000000000002';
  await pool.query('INSERT INTO guild_settings (guild_id, settings) VALUES ($1, $2::jsonb)', [otherGuild, '{"keep":"other"}']);
  await pool.query('UPDATE guild_settings SET settings = $2::jsonb WHERE guild_id = $1', [guild, '{"keep":"local"}']);
  const response = await saveSettings(await signIn());
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/settings?result=changed');
  assert.deepEqual(await savedSettings(), { keep: 'local', moderation_log_channel_id: channelId });
  const audit = await settingsAudits();
  assert.equal(audit.length, 1); assert.equal(audit[0]!.actor_id, user);
  assert.deepEqual(audit[0]!.details, { setting: 'moderation_log_channel_id', previous_channel_id: null,
    channel_id: channelId, reason: 'Use the staff log channel' });
  const other = await db.query<{ settings: unknown }>('SELECT settings FROM guild_settings WHERE guild_id = $1', [otherGuild]);
  assert.deepEqual(other.rows[0]!.settings, { keep: 'other' });
});
test('full-access Mod can save but revocation blocks the next save', async () => {
  roles = [modRole];
  await pool.query('INSERT INTO staff_access_grants (guild_id, user_id, granted_by) VALUES ($1,$2,$3)', [guild, user, user]);
  const session = await signIn();
  assert.equal((await saveSettings(session)).status, 303);
  await pool.query('DELETE FROM staff_access_grants WHERE guild_id = $1', [guild]);
  assert.equal((await saveSettings(session, { channel_id: secondChannel, previous_channel_id: channelId })).status, 403);
  assert.equal((await savedSettings()).moderation_log_channel_id, channelId);
});
test('lost staff roles block a save from an already open form', async () => {
  const session = await signIn(); roles = [];
  assert.equal((await saveSettings(session)).status, 403);
  assert.deepEqual(await savedSettings(), {});
});
test('settings checks same origin and a purpose-specific CSRF proof', async () => {
  const session = await signIn();
  assert.equal((await saveSettings(session, {}, { origin: 'https://invalid.example' })).status, 403);
  assert.equal((await saveSettings(session, {}, { origin: 'null' })).status, 403);
  assert.equal((await saveSettings(session, {}, { 'Content-Type': 'text/plain' })).status, 403);
  assert.equal((await saveSettings(session, { csrf: 'wrong' })).status, 403);
  assert.equal((await saveSettings(session, { csrf: logoutProof(session.split('=')[1]!) })).status, 403);
  assert.deepEqual(await savedSettings(), {});
});
test('expired sessions cannot save settings', async () => {
  const session = await signIn();
  await db.exec("UPDATE dashboard_sessions SET expires_at = NOW() - INTERVAL '1 minute'");
  assert.equal((await saveSettings(session)).status, 303); assert.deepEqual(await savedSettings(), {});
});
test('unavailable, foreign, and malformed channels are rejected', async () => {
  const session = await signIn();
  channels[0]!.usable = false;
  assert.equal((await saveSettings(session)).status, 400);
  channels = [];
  assert.equal((await saveSettings(session)).status, 400);
  assert.equal((await saveSettings(session, { channel_id: 'not-an-id' })).status, 400);
  assert.deepEqual(await savedSettings(), {}); assert.equal((await settingsAudits()).length, 0);
});
test('channel lookup failure does not save a setting', async () => {
  const session = await signIn(); channelFailure = true;
  assert.equal((await saveSettings(session)).status, 503); assert.deepEqual(await savedSettings(), {});
});
test('blank and overlong reasons are rejected without changes', async () => {
  const session = await signIn();
  assert.equal((await saveSettings(session, { reason: '   ' })).status, 400);
  assert.equal((await saveSettings(session, { reason: 'x'.repeat(501) })).status, 400);
  assert.deepEqual(await savedSettings(), {});
});
test('stale form cannot overwrite a later destination', async () => {
  const session = await signIn();
  assert.equal((await saveSettings(session)).status, 303);
  assert.equal((await saveSettings(session, { channel_id: secondChannel })).status, 409);
  assert.equal((await savedSettings()).moderation_log_channel_id, channelId);
  assert.equal((await settingsAudits()).length, 1);
});
test('no-op save does not duplicate the audit record', async () => {
  const session = await signIn();
  await saveSettings(session);
  const response = await saveSettings(session, { previous_channel_id: channelId });
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/settings?result=unchanged');
  assert.equal((await settingsAudits()).length, 1);
});
test('clearing a destination records its previous value', async () => {
  const session = await signIn(); await saveSettings(session);
  assert.equal((await saveSettings(session, { channel_id: '', previous_channel_id: channelId })).status, 303);
  assert.equal((await savedSettings()).moderation_log_channel_id, null);
  assert.equal((await settingsAudits())[1]!.details.previous_channel_id, channelId);
});
test('audit failure rolls back the settings update', async () => {
  const session = await signIn(); failSettingsAudit = true;
  assert.equal((await saveSettings(session)).status, 503);
  assert.deepEqual(await savedSettings(), {}); assert.equal((await settingsAudits()).length, 0);
});
test('duplicate fields and oversized requests are rejected', async () => {
  const session = await signIn();
  const response = await request('/settings', { method: 'POST', headers: {
    cookie: session, origin: base, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams([['csrf', settingsProof(session.split('=')[1]!)], ['channel_id', channelId],
    ['channel_id', secondChannel], ['previous_channel_id', ''], ['reason', 'test']]) });
  assert.equal(response.status, 400);
  assert.equal((await saveSettings(session, { reason: 'x'.repeat(5000) })).status, 413);
  assert.deepEqual(await savedSettings(), {});
});
test('settings escape channel names and show missing destinations honestly', async () => {
  channels[0]!.name = '<script>channel</script>';
  const session = await signIn(); await saveSettings(session);
  let body = await (await request('/settings', { headers: { cookie: session } })).text();
  assert.ok(body.includes('&lt;script&gt;channel&lt;/script&gt;')); assert.ok(!body.includes('<script>channel'));
  channels = [];
  body = await (await request('/settings', { headers: { cookie: session } })).text();
  assert.match(body, /Unavailable channel/);
});
test('saved destination survives a handler restart', async () => {
  const session = await signIn(); await saveSettings(session); handler = makeHandler();
  const response = await request('/settings', { headers: { cookie: session } });
  assert.match(await response.text(), /value="500000000000000001" selected/);
});

test('save rechecks current roles inside the settings transaction', async () => {
  const session = await signIn();
  let reads = 0;
  memberReadHook = async () => { if (++reads === 2) roles = []; };
  assert.equal((await saveSettings(session)).status, 403);
  assert.equal(reads, 2); assert.deepEqual(await savedSettings(), {});
});
test('save rechecks a full-access grant after the initial request check', async () => {
  roles = [modRole];
  await pool.query('INSERT INTO staff_access_grants (guild_id, user_id, granted_by) VALUES ($1,$2,$3)', [guild, user, user]);
  const session = await signIn(); let reads = 0;
  memberReadHook = async () => {
    if (++reads === 2) await pool.query('DELETE FROM staff_access_grants WHERE guild_id = $1', [guild]);
  };
  assert.equal((await saveSettings(session)).status, 403);
  assert.deepEqual(await savedSettings(), {});
});
test('overview displays the previous and new log destinations', async () => {
  const session = await signIn(); await saveSettings(session);
  const body = await (await request('/dashboard', { headers: { cookie: session } })).text();
  assert.ok(body.includes(`Moderation log channel: Not configured → ${channelId}`));
});

async function configureLog(session: string) {
  assert.equal((await saveSettings(session)).status, 303);
}
async function testForm(session: string) {
  const response = await request('/settings', { headers: { cookie: session } });
  const html = await response.text();
  const form = html.match(/<form method="post" action="\/settings\/test-log">([\s\S]*?)<\/form>/)?.[1];
  assert.ok(form, 'test log form is present');
  const fields: Record<string, string> = {};
  for (const match of form.matchAll(/name="([^"]+)" value="([^"]*)"/g)) fields[match[1]!] = match[2]!;
  return fields;
}
async function postTest(session: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return request('/settings/test-log', { method: 'POST', headers: {
    cookie: session, origin: base, 'Content-Type': 'application/x-www-form-urlencoded', ...headers,
  }, body: new URLSearchParams(fields) });
}
async function testEvents() {
  return (await db.query<{ event_type: string; actor_id: string; details: Record<string, unknown> }>(
    "SELECT event_type, actor_id, details FROM audit_events WHERE event_type LIKE 'TEST_LOG_%' ORDER BY event_id")).rows;
}
async function resultText(response: Response, session: string) {
  assert.equal(response.status, 303);
  return (await request(response.headers.get('location')!, { headers: { cookie: session } })).text();
}

test('test delivery button appears only after a usable destination is saved', async () => {
  const session = await signIn();
  let html = await (await request('/settings', { headers: { cookie: session } })).text();
  assert.ok(!html.includes('action="/settings/test-log"'));
  await configureLog(session); assert.ok((await testForm(session)).csrf);
  channels[0]!.usable = false;
  html = await (await request('/settings', { headers: { cookie: session } })).text();
  assert.ok(!html.includes('action="/settings/test-log"'));
});
test('test delivery requires a session and POST', async () => {
  assert.equal((await request('/settings/test-log', { method: 'POST' })).status, 303);
  assert.equal((await request('/settings/test-log')).status, 405);
  assert.equal(sends.length, 0);
});
test('Admin sends one embed with mentions disabled and records request plus confirmation', async () => {
  const session = await signIn(); await configureLog(session);
  const fields = await testForm(session);
  const text = await resultText(await postTest(session, fields), session);
  assert.match(text, /Discord confirmed delivery/);
  assert.equal(sends.length, 1); assert.equal(sends[0]!.channelId, channelId);
  const body = sends[0]!.body;
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.enforce_nonce, true); assert.equal(String(body.nonce).length, 25);
  assert.equal(body.embeds?.[0]?.title, 'Maru log delivery test');
  assert.match(body.embeds![0]!.description!, /No moderation action was performed/);
  const events = await testEvents();
  assert.deepEqual(events.map((event) => event.event_type), ['TEST_LOG_REQUESTED', 'TEST_LOG_SENT']);
  assert.ok(events.every((event) => event.actor_id === user && event.details.channel_id === channelId && event.details.request_id === fields.request_id));
  assert.equal(events[1]!.details.message_id, messageId);
});
test('ordinary Mods cannot see or invoke the test button', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  roles = [modRole];
  const html = await (await request('/settings', { headers: { cookie: session } })).text();
  assert.ok(!html.includes('action="/settings/test-log"'));
  assert.equal((await postTest(session, fields)).status, 403); assert.equal(sends.length, 0);
});
test('full-access Mod can send a test log', async () => {
  const session = await signIn(); await configureLog(session);
  roles = [modRole];
  await pool.query('INSERT INTO staff_access_grants (guild_id, user_id, granted_by) VALUES ($1,$2,$3)', [guild, user, user]);
  assert.equal((await postTest(session, await testForm(session))).status, 303); assert.equal(sends.length, 1);
});
test('test delivery rejects wrong origins, null origin, content type, and unrelated CSRF proofs', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  for (const origin of ['https://invalid.example', 'null', '']) {
    assert.equal((await postTest(session, fields, { origin })).status, 403);
  }
  assert.equal((await postTest(session, fields, { 'Content-Type': 'text/plain' })).status, 403);
  assert.equal((await postTest(session, { ...fields, csrf: settingsProof(session.split('=')[1]!) })).status, 403);
  assert.equal((await postTest(session, { ...fields, channel_id: secondChannel })).status, 403);
  assert.equal(sends.length, 0); assert.equal((await testEvents()).length, 0);
});
test('test delivery rejects duplicate, unknown, oversized, and malformed fields', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  assert.equal((await postTest(session, { ...fields, request_id: 'invalid' })).status, 400);
  assert.equal((await postTest(session, { ...fields, extra: 'unexpected' })).status, 400);
  assert.equal((await postTest(session, { ...fields, csrf: 'x'.repeat(1200) })).status, 413);
  const body = new URLSearchParams(fields); body.append('channel_id', channelId);
  assert.equal((await request('/settings/test-log', { method: 'POST', headers: {
    cookie: session, origin: base, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body })).status, 400);
  assert.equal(sends.length, 0);
});
test('expired session cannot send a test', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  await db.exec("UPDATE dashboard_sessions SET expires_at = NOW() - INTERVAL '1 minute'");
  assert.equal((await postTest(session, fields)).status, 303); assert.equal(sends.length, 0);
});
test('lost roles and revoked grants block an open test form', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  roles = [modRole];
  assert.equal((await postTest(session, fields)).status, 403);
  roles = [];
  assert.equal((await postTest(session, fields)).status, 403);
  assert.equal(sends.length, 0);
});
test('test delivery rechecks access inside its claim transaction', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  let reads = 0; memberReadHook = async () => { if (++reads === 2) roles = []; };
  assert.equal((await postTest(session, fields)).status, 403);
  assert.equal(reads, 2); assert.equal(sends.length, 0); assert.equal((await testEvents()).length, 0);
});
test('changed or cleared destination does not redirect an old test to another channel', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  await saveSettings(session, { channel_id: secondChannel, previous_channel_id: channelId });
  assert.equal((await postTest(session, fields)).status, 409);
  await saveSettings(session, { channel_id: '', previous_channel_id: secondChannel });
  assert.equal((await postTest(session, fields)).status, 409); assert.equal(sends.length, 0);
});
test('deleted channel or missing permissions blocks test delivery', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  channels[0]!.usable = false;
  assert.equal((await postTest(session, fields)).status, 409);
  channels = [];
  assert.equal((await postTest(session, fields)).status, 409); assert.equal(sends.length, 0);
});
test('Discord channel validation failure cannot dispatch a test', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  channelFailure = true;
  assert.equal((await postTest(session, fields)).status, 503);
  assert.equal(sends.length, 0); assert.equal((await testEvents()).length, 0);
});
test('resubmitting the same test and refreshing its result never resends', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  const response = await postTest(session, fields);
  await resultText(response, session); await resultText(response, session);
  handler = makeHandler();
  assert.match(await resultText(await postTest(session, fields), session), /Discord confirmed delivery/);
  assert.equal(sends.length, 1); assert.equal((await testEvents()).length, 2);
});
test('per-server cooldown survives handler restart and allows a later new test', async () => {
  const session = await signIn(); await configureLog(session);
  await postTest(session, await testForm(session)); handler = makeHandler();
  const fields = await testForm(session);
  assert.match(await resultText(await postTest(session, fields), session), /wait 30 seconds/);
  assert.equal(sends.length, 1);
  await db.exec("UPDATE audit_events SET created_at = NOW() - INTERVAL '31 seconds' WHERE event_type = 'TEST_LOG_REQUESTED'");
  assert.match(await resultText(await postTest(session, fields), session), /Discord confirmed delivery/);
  assert.equal(sends.length, 2); assert.equal((await testEvents()).length, 4);
});
test('Discord rejection is recorded without falsely reporting delivery', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  sendFailure = 'forbidden';
  assert.match(await resultText(await postTest(session, fields), session), /Discord rejected/);
  assert.equal((await testEvents())[1]!.event_type, 'TEST_LOG_REJECTED');
  await postTest(session, fields); assert.equal(sends.length, 1);
});
test('lost Discord response is unconfirmed and is never automatically retried', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  sendFailure = 'network';
  const html = await resultText(await postTest(session, fields), session);
  assert.match(html, /Delivery was not confirmed/); assert.ok(!html.includes('private network diagnostic'));
  assert.equal((await testEvents())[1]!.event_type, 'TEST_LOG_UNCONFIRMED');
  await postTest(session, fields); assert.equal(sends.length, 1);
});
test('invalid Discord delivery response is not reported as sent', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  sendFailure = 'invalid';
  assert.match(await resultText(await postTest(session, fields), session), /Delivery was not confirmed/);
});
test('failed request audit prevents the external send', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  failTestAudit = 'request';
  assert.equal((await postTest(session, fields)).status, 503);
  assert.equal(sends.length, 0); assert.equal((await testEvents()).length, 0);
});
test('failed result audit preserves the claimed request and does not resend', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  failTestAudit = 'result';
  assert.match(await resultText(await postTest(session, fields), session), /final delivery result is unavailable/);
  assert.equal(sends.length, 1); assert.equal((await testEvents()).length, 1);
  failTestAudit = undefined;
  await postTest(session, fields); assert.equal(sends.length, 1);
});
test('an interrupted claimed request remains pending after restart without resending', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  await pool.query(`INSERT INTO audit_events (guild_id, actor_id, event_type, details)
    VALUES ($1,$2,'TEST_LOG_REQUESTED',$3::jsonb)`, [guild, user,
      JSON.stringify({ request_id: fields.request_id, channel_id: channelId })]);
  handler = makeHandler();
  assert.match(await resultText(await postTest(session, fields), session), /final delivery result is unavailable/);
  assert.equal(sends.length, 0);
});
test('result pages read server-scoped audit records rather than trusting URL success claims', async () => {
  const session = await signIn(); await configureLog(session);
  const id = randomToken(); const otherGuild = '100000000000000002';
  await pool.query('INSERT INTO guild_settings (guild_id) VALUES ($1)', [otherGuild]);
  await pool.query(`INSERT INTO audit_events (guild_id, actor_id, event_type, details)
    VALUES ($1,$2,'TEST_LOG_SENT',$3::jsonb)`, [otherGuild, user, JSON.stringify({ request_id: id, channel_id: 'private-channel' })]);
  const html = await (await request(`/settings?test=${id}`, { headers: { cookie: session } })).text();
  assert.ok(!html.includes('private-channel')); assert.ok(!html.includes('Discord confirmed delivery'));
  assert.equal(sends.length, 0);
});

test('reconnecting bot does not claim or dispatch a test message', async () => {
  const session = await signIn(); await configureLog(session); const fields = await testForm(session);
  botReady = false;
  assert.equal((await postTest(session, fields)).status, 503);
  assert.equal(sends.length, 0); assert.equal((await testEvents()).length, 0);
});
test('revoking a full-access grant during test authorization prevents delivery', async () => {
  const session = await signIn(); await configureLog(session);
  roles = [modRole];
  await pool.query('INSERT INTO staff_access_grants (guild_id, user_id, granted_by) VALUES ($1,$2,$3)', [guild, user, user]);
  const fields = await testForm(session); let reads = 0;
  memberReadHook = async () => {
    if (++reads === 2) await pool.query('DELETE FROM staff_access_grants WHERE guild_id = $1', [guild]);
  };
  assert.equal((await postTest(session, fields)).status, 403);
  assert.equal(sends.length, 0); assert.equal((await testEvents()).length, 0);
});
