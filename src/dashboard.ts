import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { getStaffAccess } from './staff-access.js';
import {
  caseChangeProof, cookie, cookieName, digest, equal, logoutProof, randomToken, readCookie, settingsProof, testLogProof, validToken,
} from './web-security.js';
import type { DashboardConfig } from './web-security.js';
import { dashboardPage, loginPage, messagePage, settingsPage, caseHistoryPage, caseDetailPage } from './web-pages.js';
import { CaseHistoryError, parseCaseFilter, parseCaseNumber, loadCaseHistory, loadCaseDetail, loadCaseChanges } from './case-history.js';
import { changeCase, CaseChangeError } from './case-changes.js';
import { sendTestLog } from './test-log.js';
import type { SendTestMessage } from './test-log.js';
import { logChannelId, saveLogChannel, SettingsError } from './server-settings.js';
import type { LogChannel } from './server-settings.js';
import { handleStarboardPage } from './starboard-web.js';
import type { StarboardResources } from './starboard-settings.js';
import type { AuditRow } from './web-pages.js';

type Session = { user_id: string; display_name: string };
type Options = {
  pool: Pick<Pool, 'query' | 'connect'>;
  guildId: string;
  config?: DashboardConfig;
  isBotReady: () => boolean;
  readMemberRoles: (userId: string) => Promise<string[] | null>;
  readLogChannels?: () => Promise<LogChannel[]>;
  sendTestMessage?: SendTestMessage;
  readStarboardResources?: () => Promise<StarboardResources>;
  fetcher?: typeof fetch;
};

function headers(response: ServerResponse, nonce: string): void {
  response.setHeader('Cache-Control', 'no-store');
  // Preserve Origin on same-origin form POSTs; suppress cross-origin referrers.
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy',
    `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
}

function html(response: ServerResponse, status: number, render: (nonce: string) => string): void {
  const nonce = randomToken();
  headers(response, nonce);
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(render(nonce));
}
function message(response: ServerResponse, status: number, title: string, text: string): void {
  html(response, status, (nonce) => messagePage(title, text, nonce));
}
function redirect(response: ServerResponse, location: string): void {
  headers(response, randomToken());
  response.writeHead(303, { Location: location });
  response.end();
}

export function createDashboardHandler(options: Options) {
  const { pool, guildId, config, isBotReady, readMemberRoles } = options;
  const fetcher = options.fetcher ?? fetch;
  let windowStart = Date.now();
  let starts = 0;
  let callbacks = 0;

  async function sessionFor(token: string | undefined): Promise<Session | undefined> {
    if (!token) return undefined;
    const result = await pool.query<Session>(
      `SELECT user_id, display_name FROM dashboard_sessions
       WHERE token_hash = $1 AND guild_id = $2 AND expires_at > NOW()`, [digest(token), guildId]);
    return result.rows[0];
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const routes = ['/', '/dashboard', '/auth/discord', '/auth/discord/callback', '/auth/logout', '/settings', '/settings/test-log', '/cases'];
    const starboardPath = /^\/starboards(?:\/[^/]+(?:\/(?:create|save|delete|delete-confirm))?)?$/.test(path);
    const starboardMutation = /^\/starboards\/[^/]+\/(?:create|save|delete)$/.test(path);
    const caseDetail = /^\/cases\/([^/]+)$/.exec(path);
    const caseMutation = /^\/cases\/([^/]+)\/(correct|void)$/.exec(path);
    if (!routes.includes(path) && !caseDetail && !caseMutation && !starboardPath) {
      message(response, 404, 'Page not found', 'This page is not available.');
      return;
    }
    if (!config) {
      message(response, 503, 'Dashboard setup pending', 'Dashboard sign-in has not been configured yet.');
      return;
    }
    const expectedMethod = (caseMutation || starboardMutation || ['/auth/logout', '/settings/test-log'].includes(path)) ? 'POST' : path === '/settings' ? 'GET, POST' : 'GET';
    if (!expectedMethod.split(', ').includes(request.method ?? '')) {
      response.setHeader('Allow', expectedMethod);
      message(response, 405, 'Method not allowed', 'Use the dashboard controls to continue.');
      return;
    }

    const sessionName = cookieName('session', config.secure);
    const loginName = cookieName('login', config.secure);
    const sessionToken = readCookie(request, sessionName);

    if (path === '/') {
      if (await sessionFor(sessionToken)) redirect(response, '/dashboard');
      else html(response, 200, loginPage);
      return;
    }

    if (path === '/auth/discord' || path === '/auth/discord/callback') {
      if (!isBotReady()) {
        message(response, 503, 'Temporarily unavailable', 'Maru is reconnecting. Please try signing in again shortly.');
        return;
      }
      if (Date.now() - windowStart > 60000) { windowStart = Date.now(); starts = 0; callbacks = 0; }
      const limited = path === '/auth/discord' ? ++starts > 30 : ++callbacks > 60;
      if (limited) {
        response.setHeader('Retry-After', '60');
        message(response, 429, 'Please wait', 'Too many sign-in requests. Please try again in a minute.');
        return;
      }
    }

    if (path === '/auth/discord') {
      await pool.query('DELETE FROM dashboard_login_attempts WHERE expires_at <= NOW()');
      await pool.query('DELETE FROM dashboard_sessions WHERE expires_at <= NOW()');
      const oldLogin = readCookie(request, loginName);
      if (oldLogin) await pool.query('DELETE FROM dashboard_login_attempts WHERE token_hash = $1', [digest(oldLogin)]);
      const browserToken = randomToken();
      const state = randomToken();
      await pool.query(
        `INSERT INTO dashboard_login_attempts (token_hash, state_hash, guild_id, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')`, [digest(browserToken), digest(state), guildId]);
      const authorization = new URL('https://discord.com/oauth2/authorize');
      authorization.search = new URLSearchParams({
        client_id: config.applicationId, response_type: 'code', scope: 'identify',
        redirect_uri: `${config.origin}/auth/discord/callback`, state,
      }).toString();
      response.setHeader('Set-Cookie', cookie(loginName, browserToken, 300, config.secure));
      redirect(response, authorization.toString());
      return;
    }

    if (path === '/auth/discord/callback') {
      const params = new URL(request.url ?? '/', config.origin).searchParams;
      const state = params.get('state');
      const browserToken = readCookie(request, loginName);
      response.setHeader('Set-Cookie', cookie(loginName, '', 0, config.secure));
      if (!browserToken || !validToken(state ?? undefined) || params.getAll('state').length !== 1 ||
          params.getAll('iss').length > 1 || (params.has('iss') && params.get('iss') !== 'https://discord.com')) {
        message(response, 400, 'Sign-in expired', 'Please start a new sign-in from this website.');
        return;
      }
      const attempt = await pool.query(
        `DELETE FROM dashboard_login_attempts
         WHERE token_hash = $1 AND state_hash = $2 AND guild_id = $3 AND expires_at > NOW()
         RETURNING token_hash`, [digest(browserToken), digest(state!), guildId]);
      if (attempt.rowCount !== 1) {
        message(response, 400, 'Sign-in expired', 'This sign-in was already used or has expired. Please start again.');
        return;
      }
      // A completed sign-in attempt replaces any previous browser identity.
      if (sessionToken) await pool.query('DELETE FROM dashboard_sessions WHERE token_hash = $1', [digest(sessionToken)]);
      response.setHeader('Set-Cookie', [cookie(loginName, '', 0, config.secure), cookie(sessionName, '', 0, config.secure)]);
      if (params.has('error')) {
        message(response, 400, 'Sign-in cancelled', 'You can start again whenever you are ready.');
        return;
      }
      const code = params.get('code');
      if (!code || code.length > 2048 || params.getAll('code').length !== 1) {
        message(response, 400, 'Sign-in failed', 'Please start a new sign-in.');
        return;
      }

      let accessToken: string | undefined;
      try {
        const tokenResponse = await fetcher('https://discord.com/api/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: config.applicationId, client_secret: config.clientSecret,
            grant_type: 'authorization_code', code, redirect_uri: `${config.origin}/auth/discord/callback` }),
          signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        if (!tokenResponse.ok) throw new Error('OAUTH_EXCHANGE_FAILED');
        const tokenData = await tokenResponse.json() as { access_token?: unknown; token_type?: unknown };
        if (typeof tokenData.access_token !== 'string' || tokenData.access_token.length > 8192 ||
            !/^\S+$/.test(tokenData.access_token) || String(tokenData.token_type).toLowerCase() !== 'bearer') {
          throw new Error('INVALID_OAUTH_RESPONSE');
        }
        accessToken = tokenData.access_token;
        const userResponse = await fetcher('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        if (!userResponse.ok) throw new Error('IDENTITY_LOOKUP_FAILED');
        const user = await userResponse.json() as { id?: unknown; username?: unknown; global_name?: unknown };
        if (typeof user.id !== 'string' || !/^\d{17,20}$/.test(user.id) || typeof user.username !== 'string') {
          throw new Error('INVALID_IDENTITY');
        }
        const roles = await readMemberRoles(user.id);
        const access = roles ? await getStaffAccess(pool, guildId, user.id, roles) : 'none';
        if (access === 'none') {
          message(response, 403, 'Staff access required', 'Your account does not currently have a configured Maru staff role in this server.');
          return;
        }
        const newSession = randomToken();
        await pool.query(
          `INSERT INTO dashboard_sessions (token_hash, guild_id, user_id, display_name, expires_at)
           VALUES ($1, $2, $3, $4, NOW() + INTERVAL '8 hours')`,
          [digest(newSession), guildId, user.id, (typeof user.global_name === 'string' ? user.global_name : user.username).slice(0, 100)]);
        response.setHeader('Set-Cookie', [
          cookie(loginName, '', 0, config.secure), cookie(sessionName, newSession, 28800, config.secure),
        ]);
        redirect(response, '/dashboard');
      } finally {
        // Identity is all we need. Never persist OAuth access/refresh tokens.
        if (accessToken) {
          try {
            const result = await fetcher('https://discord.com/api/oauth2/token/revoke', {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ client_id: config.applicationId, client_secret: config.clientSecret,
                token: accessToken, token_type_hint: 'access_token' }),
              signal: AbortSignal.timeout(3000), redirect: 'error',
            });
            if (!result.ok) console.error('Temporary Discord sign-in token could not be revoked.');
          } catch { console.error('Temporary Discord sign-in token revocation was unavailable.'); }
        }
      }
      return;
    }

    if (path === '/auth/logout') {
      if (request.headers.origin !== config.origin ||
          !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
        message(response, 403, 'Request rejected', 'Use the sign-out button on the dashboard.');
        return;
      }
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 1024) throw new Error('BODY_TOO_LARGE');
      }
      const params = new URLSearchParams(body);
      const proof = params.get('csrf');
      if (!sessionToken || params.getAll('csrf').length !== 1 || !proof || !equal(proof, logoutProof(sessionToken))) {
        message(response, 403, 'Request rejected', 'Please use the sign-out button on the dashboard.');
        return;
      }
      await pool.query('DELETE FROM dashboard_sessions WHERE token_hash = $1 AND guild_id = $2', [digest(sessionToken), guildId]);
      response.setHeader('Set-Cookie', cookie(sessionName, '', 0, config.secure));
      redirect(response, '/');
      return;
    }

    const session = await sessionFor(sessionToken);
    if (!session || !sessionToken) {
      response.setHeader('Set-Cookie', cookie(sessionName, '', 0, config.secure));
      redirect(response, '/');
      return;
    }
    if (!isBotReady()) throw new Error('BOT_NOT_READY');
    const roles = await readMemberRoles(session.user_id);
    const access = roles ? await getStaffAccess(pool, guildId, session.user_id, roles) : 'none';
    if (access === 'none') {
      await pool.query('DELETE FROM dashboard_sessions WHERE token_hash = $1', [digest(sessionToken)]);
      response.setHeader('Set-Cookie', cookie(sessionName, '', 0, config.secure));
      message(response, 403, 'Staff access required', 'Your current roles no longer provide access. Please contact an Admin.');
      return;
    }
    if (starboardPath) {
      if (!options.readStarboardResources) throw new Error('STARBOARD_RESOURCES_UNAVAILABLE');
      await handleStarboardPage(request,path,{ pool,guildId,actorId: session.user_id,sessionToken,origin: config.origin,
        readMemberRoles,readResources: options.readStarboardResources },{
        html: (status,render) => html(response,status,render),message: (status,title,text) => message(response,status,title,text),
        redirect: (location) => redirect(response,location),
      });
      return;
    }
    if (caseMutation) {
      try {
        const number = parseCaseNumber(caseMutation[1]!);
        const action = caseMutation[2] as 'correct' | 'void';
        if (request.headers.origin !== config.origin ||
            request.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') {
          message(response, 403, 'Request rejected', 'Reload the case page and use its change form.'); return;
        }
        let body = '';
        for await (const chunk of request) {
          body += String(chunk);
          if (Buffer.byteLength(body) > 16384) {
            message(response, 413, 'Request too large', 'Use the case change form.'); return;
          }
        }
        const params = new URLSearchParams(body);
        const keys = action === 'correct' ? ['csrf', 'revision', 'reason', 'new_reason'] : ['csrf', 'revision', 'reason', 'confirm'];
        const revisionText = params.get('revision') ?? '';
        if (keys.some((key) => params.getAll(key).length !== 1) || [...params.keys()].some((key) => !keys.includes(key)) ||
            !/^(0|[1-9]\d{0,9})$/.test(revisionText) || Number(revisionText) > 2147483647) {
          throw new CaseChangeError('INVALID_INPUT');
        }
        const revision = Number(revisionText);
        if (!equal(params.get('csrf')!, caseChangeProof(sessionToken, number, revision, action))) {
          message(response, 403, 'Request rejected', 'Reload the case page and try again.'); return;
        }
        if (action === 'void' && params.get('confirm') !== String(number)) throw new CaseChangeError('CONFIRM_REQUIRED');
        await changeCase(pool, { guildId, actorId: session.user_id, sessionToken, caseNumber: number,
          expectedRevision: revision, action, reason: params.get('reason')!,
          newReason: params.get('new_reason') ?? undefined, readMemberRoles });
        redirect(response, `/cases/${number}`);
      } catch (error) {
        if (!(error instanceof CaseChangeError) && !(error instanceof CaseHistoryError)) throw error;
        const messages: Record<string, [number, string]> = {
          ACTION_READ_ONLY: [409, 'Discord action cases are read only. Use /untimeout or /unban for the corresponding Discord action.'],
          ACCESS_DENIED: [403, 'Mods may change only warnings they issued. Admins and Mods with full access may change any warning.'],
          SESSION_EXPIRED: [403, 'Your session expired. Sign in again before changing this case.'],
          CASE_NOT_FOUND: [404, 'No case with that number exists in this server.'],
          STALE_CASE: [409, 'The case changed while this form was open. Reload it before trying again.'],
          CASE_VOIDED: [409, 'This warning is already voided. Its history is retained.'],
          INVALID_REASON: [400, 'The corrected reason and change justification must each contain 1 to 500 characters.'],
          INVALID_INPUT: [400, 'Reload the case and use its change form.'],
          CONFIRM_REQUIRED: [400, 'Enter the case number in the confirmation field to void this warning.'],
        };
        const [status, text] = error instanceof CaseChangeError ? messages[error.code] ?? [400, 'Invalid case change.'] : [400, error.message];
        html(response, status, (nonce) => caseHistoryPage({ cases: [], hasOlder: false, filter: {},
          nonce, csrf: logoutProof(sessionToken), error: text }));
      }
      return;
    }
    if (path === '/cases' || caseDetail) {
      try {
        if (caseDetail) {
          const number = parseCaseNumber(caseDetail[1]!);
          const record = await loadCaseDetail(pool, guildId, number);
          if (!record) {
            html(response, 404, (nonce) => caseHistoryPage({ cases: [], hasOlder: false, filter: {},
              nonce, csrf: logoutProof(sessionToken), error: 'No case with that number exists in this server.' }));
            return;
          }
          const changes = await loadCaseChanges(pool, guildId, number);
          html(response, 200, (nonce) => caseDetailPage({ record, nonce, csrf: logoutProof(sessionToken), changes,
            canChange: access === 'admin' || record.actor_id === session.user_id,
            correctCsrf: caseChangeProof(sessionToken, number, record.revision, 'correct'),
            voidCsrf: caseChangeProof(sessionToken, number, record.revision, 'void') }));
        } else {
          const filter = parseCaseFilter(new URL(request.url ?? '/', config.origin).searchParams);
          const page = await loadCaseHistory(pool, guildId, filter);
          html(response, 200, (nonce) => caseHistoryPage({ ...page, filter, nonce, csrf: logoutProof(sessionToken) }));
        }
      } catch (error) {
        if (!(error instanceof CaseHistoryError)) throw error;
        html(response, 400, (nonce) => caseHistoryPage({ cases: [], hasOlder: false, filter: {},
          nonce, csrf: logoutProof(sessionToken), error: error.message }));
      }
      return;
    }
    if (path === '/settings/test-log') {
      if (access !== 'admin') {
        message(response, 403, 'Admin access required', 'Only Admins and Mods granted full access can send a test log.'); return;
      }
      if (!options.readLogChannels || !options.sendTestMessage) throw new Error('TEST_LOG_UNAVAILABLE');
      if (request.headers.origin !== config.origin ||
          request.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') {
        message(response, 403, 'Request rejected', 'Reload Server settings and use Send test log.'); return;
      }
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 1024) {
          message(response, 413, 'Request too large', 'Reload Server settings and try again.'); return;
        }
      }
      const params = new URLSearchParams(body);
      const keys = ['csrf', 'request_id', 'channel_id'];
      const requestId = params.get('request_id') ?? '';
      const expectedChannelId = params.get('channel_id') ?? '';
      if (keys.some((key) => params.getAll(key).length !== 1) ||
          [...params.keys()].some((key) => !keys.includes(key)) || !validToken(requestId) ||
          !/^\d{17,20}$/.test(expectedChannelId)) {
        message(response, 400, 'Invalid request', 'Reload Server settings and use Send test log.'); return;
      }
      if (!equal(params.get('csrf')!, testLogProof(sessionToken, requestId, expectedChannelId))) {
        message(response, 403, 'Request rejected', 'Reload Server settings and use Send test log.'); return;
      }
      try {
        await sendTestLog(pool, { guildId, actorId: session.user_id, sessionToken,
          requestId, expectedChannelId, readMemberRoles, readLogChannels: options.readLogChannels,
          sendMessage: options.sendTestMessage });
        // Show the durable outcome with GET; refreshing must never submit another send.
        redirect(response, `/settings?test=${requestId}`);
      } catch (error) {
        if (!(error instanceof SettingsError)) throw error;
        const status = error.code === 'ADMIN_REQUIRED' || error.code === 'SESSION_EXPIRED' ? 403 : 409;
        const text = error.code === 'CHANNEL_UNAVAILABLE' ? 'Maru cannot send embeds to the saved channel. Check its channel permissions.' :
          error.code === 'LOG_CHANNEL_REQUIRED' ? 'Save a moderation log channel before sending a test.' :
          error.code === 'SETTINGS_CHANGED' ? 'The saved destination changed. Reload settings before sending a test.' :
          'Your current session or access does not allow this test. Sign in again and reload settings.';
        html(response, status, (nonce) => settingsPage({ access, channelId: null, channels: [],
          csrf: settingsProof(sessionToken), logoutCsrf: logoutProof(sessionToken), nonce, error: text }));
      }
      return;
    }
    if (path === '/settings') {
      if (!options.readLogChannels) throw new Error('CHANNEL_LOOKUP_UNAVAILABLE');
      if (request.method === 'POST') {
        if (access !== 'admin') {
          message(response, 403, 'Admin access required', 'Only Admins and Mods granted full access can change server settings.');
          return;
        }
        if (request.headers.origin !== config.origin ||
            request.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') {
          message(response, 403, 'Request rejected', 'Use the server settings form to save changes.');
          return;
        }
        let body = '';
        for await (const chunk of request) {
          body += String(chunk);
          if (Buffer.byteLength(body) > 4096) {
            message(response, 413, 'Request too large', 'Please use the server settings form.');
            return;
          }
        }
        const params = new URLSearchParams(body);
        const keys = ['csrf', 'channel_id', 'previous_channel_id', 'reason'];
        if (keys.some((key) => params.getAll(key).length !== 1) ||
            [...params.keys()].some((key) => !keys.includes(key))) {
          message(response, 400, 'Invalid settings', 'Reload the settings page and try again.'); return;
        }
        if (!equal(params.get('csrf')!, settingsProof(sessionToken))) {
          message(response, 403, 'Request rejected', 'Reload the settings page and try again.'); return;
        }
        try {
          const changed = await saveLogChannel(pool, {
            guildId, actorId: session.user_id, sessionToken,
            channelId: params.get('channel_id') || null,
            previousChannelId: params.get('previous_channel_id') || null,
            reason: params.get('reason')!, readMemberRoles, readLogChannels: options.readLogChannels,
          });
          redirect(response, `/settings?result=${changed}`);
        } catch (error) {
          if (!(error instanceof SettingsError)) throw error;
          const errors: Record<string, [number, string]> = {
            ADMIN_REQUIRED: [403, 'Your current access does not allow settings changes.'],
            SESSION_EXPIRED: [403, 'Your session expired. Sign in again.'],
            SETTINGS_CHANGED: [409, 'Another staff member changed this setting. Reload the settings page before trying again.'],
            CHANNEL_UNAVAILABLE: [400, 'Choose an available text or announcement channel where Maru can view the channel, send messages, and embed links.'],
            INVALID_CHANNEL: [400, 'Choose a channel from the settings form.'],
            INVALID_REASON: [400, 'Enter a reason between 1 and 500 characters.'],
            SERVER_NOT_CONFIGURED: [409, 'This server has not been configured.'],
          };
          const [status, text] = errors[error.code] ?? [400, 'Reload the settings page and try again.'];
          html(response, status, (nonce) => settingsPage({ access, channelId: null, channels: [],
            csrf: settingsProof(sessionToken), logoutCsrf: logoutProof(sessionToken), nonce, error: text }));
        }
        return;
      }
      const settings = await pool.query<{ settings: Record<string, unknown> }>(
        'SELECT settings FROM guild_settings WHERE guild_id = $1', [guildId]);
      if (!settings.rows[0]) throw new Error('SERVER_NOT_CONFIGURED');
      const channels = await options.readLogChannels();
      const testRequestId = randomToken();
      const selectedChannelId = logChannelId(settings.rows[0]!.settings);
      const query = new URL(request.url ?? '/', config.origin).searchParams;
      const result = query.get('result');
      let testNotice: string | undefined;
      if (validToken(query.get('test') ?? undefined)) {
        const outcome = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
          `SELECT event_type, details FROM audit_events WHERE guild_id = $1 AND actor_id = $2
           AND details->>'request_id' = $3
           AND event_type IN ('TEST_LOG_REQUESTED', 'TEST_LOG_SENT', 'TEST_LOG_REJECTED', 'TEST_LOG_UNCONFIRMED')
           ORDER BY event_id DESC LIMIT 1`, [guildId, session.user_id, query.get('test')]);
        const event = outcome.rows[0];
        testNotice = event?.event_type === 'TEST_LOG_SENT'
          ? `Discord confirmed delivery of the test embed to channel ${String(event.details.channel_id)}. The result is recorded in Recent staff activity.`
          : event?.event_type === 'TEST_LOG_REJECTED'
          ? 'Discord rejected the test message. Check channel access and bot permissions. The result is recorded in Recent staff activity.'
          : event?.event_type === 'TEST_LOG_UNCONFIRMED'
          ? 'Delivery was not confirmed. Check the saved channel before requesting another test. The result is recorded in Recent staff activity.'
          : event ? 'The test request is recorded, but its final delivery result is unavailable. Check the channel before requesting another test.'
          : 'No new test was sent. Please wait 30 seconds between test requests for this server, then reload settings.';
      }
      html(response, 200, (nonce) => settingsPage({ access,
        channelId: logChannelId(settings.rows[0]!.settings), channels,
        csrf: settingsProof(sessionToken), logoutCsrf: logoutProof(sessionToken), nonce,
        testRequestId, testCsrf: testLogProof(sessionToken, testRequestId, selectedChannelId ?? ''),
        notice: testNotice ?? (result === 'changed' ? 'Setting saved and recorded in the audit log.' :
          result === 'unchanged' ? 'No change was needed.' : undefined) }));
      return;
    }
    const events = await pool.query<AuditRow>(
      `SELECT event_id, event_type, actor_id, details, created_at FROM audit_events
       WHERE guild_id = $1 ORDER BY event_id DESC LIMIT 20`, [guildId]);
    html(response, 200, (nonce) => dashboardPage({ name: session.display_name, access, guildId,
      botReady: isBotReady(), events: events.rows, csrf: logoutProof(sessionToken), nonce }));
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try { await route(request, response); }
    catch {
      // Do not log callback URLs, cookies, tokens, or raw provider errors.
      console.error('Dashboard request failed. No sensitive request details were logged.');
      if (!response.headersSent) message(response, 503, 'Temporarily unavailable', 'Maru could not complete this request. If you were making a change or sending a test log, reload the affected page and check its saved state and audit history before retrying.');
      else response.end();
    }
  };
}
