import type { Pool } from 'pg';
import type { WarningCase } from './warnings.js';

export class CaseHistoryError extends Error {}
export type CaseFilter = { memberId?: string; before?: number };
const validCase = (value: string) => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647;
export function parseCaseNumber(value: string): number {
  if (!validCase(value)) throw new CaseHistoryError('Enter a case number between 1 and 2147483647.');
  return Number(value);
}
export function parseCaseFilter(params: URLSearchParams): CaseFilter {
  if ([...params.keys()].some((key) => !['member', 'before'].includes(key)) ||
      params.getAll('member').length > 1 || params.getAll('before').length > 1) {
    throw new CaseHistoryError('Use the member filter or a pagination link from this page.');
  }
  const memberId = params.get('member')?.trim() || undefined;
  if (memberId && !/^\d{17,20}$/.test(memberId)) {
    throw new CaseHistoryError('Enter a Discord member ID with 17 to 20 digits, or leave the filter empty.');
  }
  return { memberId, before: params.has('before') ? parseCaseNumber(params.get('before')!) : undefined };
}
export function caseHistoryUrl(filter: CaseFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.memberId) params.set('member', filter.memberId);
  if (filter.before !== undefined) params.set('before', String(filter.before));
  return `/cases${params.size ? `?${params}` : ''}`;
}

// Call only after the dashboard's current-session/current-staff check.
// The server ID always comes from host configuration, never the URL.
export async function loadCaseHistory(pool: Pick<Pool, 'query'>, guildId: string, filter: CaseFilter) {
  const values: (string | number)[] = [guildId];
  const conditions = ['guild_id = $1'];
  if (filter.memberId) { values.push(filter.memberId); conditions.push(`target_user_id = $${values.length}`); }
  if (filter.before !== undefined) { values.push(filter.before); conditions.push(`case_number < $${values.length}`); }
  const result = await pool.query<WarningCase>(
    `SELECT * FROM moderation_cases WHERE ${conditions.join(' AND ')} ORDER BY case_number DESC LIMIT 21`, values);
  return { cases: result.rows.slice(0, 20), hasOlder: result.rows.length > 20 };
}
export async function loadCaseDetail(pool: Pick<Pool, 'query'>, guildId: string, caseNumber: number) {
  const result = await pool.query<WarningCase>(
    'SELECT * FROM moderation_cases WHERE guild_id = $1 AND case_number = $2', [guildId, caseNumber]);
  return result.rows[0];
}

export type CaseChangeEvent = {
  event_id: string; actor_id: string; event_type: string;
  details: Record<string, unknown>; created_at: Date;
};
export async function loadCaseChanges(pool: Pick<Pool, 'query'>, guildId: string, caseNumber: number) {
  const result = await pool.query<CaseChangeEvent>(
    `SELECT event_id, actor_id, event_type, details, created_at FROM audit_events
     WHERE guild_id = $1 AND details->>'case_number' = $2
     AND event_type IN ('CASE_REASON_CORRECTED', 'CASE_VOIDED') ORDER BY event_id DESC LIMIT 50`,
    [guildId, String(caseNumber)]);
  return result.rows;
}
