export function actionLabel(action: string): string {
  return ({ warning: 'Warning', timeout: 'Timeout', untimeout: 'Timeout removal', ban: 'Ban', unban: 'Unban', softban: 'Honeypot softban' } as Record<string,string>)[action] ?? 'Moderation action';
}
export function actionResultLabel(status: string): string {
  return ({ not_applicable: 'Not applicable', pending: 'Not attempted', applying: 'Not confirmed (attempt started)',
    applied: 'Applied', rejected: 'Rejected', unconfirmed: 'Not confirmed' } as Record<string,string>)[status] ?? 'Unknown';
}
export function parseTimeoutDuration(text: string): number {
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(text.trim());
  const scale = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  const seconds = match ? Number(match[1]) * scale[match[2]!.toLowerCase() as keyof typeof scale] : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 2419200) {
    throw new Error('Use a duration like 30s, 10m, 2h, 1d, or 1w; maximum 28d.');
  }
  return seconds;
}
export function durationLabel(seconds: number): string {
  for (const [unit, size] of [['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]] as const) {
    if (seconds % size === 0) return `${seconds / size} ${unit}${seconds / size === 1 ? '' : 's'}`;
  }
  return `${seconds} seconds`;
}
