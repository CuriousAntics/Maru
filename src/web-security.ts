import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export type DashboardConfig = {
  origin: string;
  applicationId: string;
  clientSecret: string;
  secure: boolean;
};

export function dashboardConfig(env: NodeJS.ProcessEnv): DashboardConfig | undefined {
  const base = env.APP_BASE_URL?.trim();
  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  if (!base || !applicationId || !clientSecret) return undefined;
  const url = new URL(base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') ||
      !['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || !/^\d{17,20}$/.test(applicationId)) {
    throw new Error('INVALID_DASHBOARD_CONFIGURATION');
  }
  return { origin: url.origin, applicationId, clientSecret, secure: url.protocol === 'https:' };
}

export function randomToken(): string { return randomBytes(32).toString('base64url'); }
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function validToken(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}
export function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function logoutProof(token: string): string {
  return createHmac('sha256', token).update('maru-dashboard-logout').digest('base64url');
}
export function settingsProof(token: string): string {
  return createHmac('sha256', token).update('maru-dashboard-settings').digest('base64url');
}
export function testLogProof(token: string, requestId: string, channelId: string): string {
  return createHmac('sha256', token).update(`maru-test-log:${requestId}:${channelId}`).digest('base64url');
}
export function cookieName(kind: 'login' | 'session', secure: boolean): string {
  return `${secure ? '__Host-' : ''}maru_${kind}`;
}
export function cookie(name: string, value: string, seconds: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}
export function readCookie(request: IncomingMessage, name: string): string | undefined {
  const matches = (request.headers.cookie ?? '').split(';')
    .map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.slice(name.length + 1);
  return validToken(value) ? value : undefined;
}
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}
