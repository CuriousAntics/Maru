import { escapeHtml } from './web-security.js';

const css = `
:root{color-scheme:dark;font-family:Inter,Segoe UI,system-ui,sans-serif;background:#101315;color:#eef0eb}
*{box-sizing:border-box}body{margin:0}a{color:inherit}.shell{max-width:1160px;margin:auto;padding:32px 30px 60px}
header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #303636;padding-bottom:23px;gap:20px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;font-size:22px;font-weight:700;letter-spacing:-.7px}
.mark{display:grid;place-items:center;width:37px;height:37px;border-radius:12px;background:#e6ad73;color:#171818}
.eyebrow{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#a7b2a7;margin:0 0 14px}
.hero{padding:54px 0 30px}.hero h1{font-size:clamp(30px,4vw,46px);letter-spacing:-1.6px;margin:0 0 12px;font-weight:600}
p{color:#acb5b2;line-height:1.65;max-width:690px}.pill{font-size:12px;color:#cadbbf;border:1px solid #40503f;border-radius:24px;padding:7px 12px;white-space:nowrap}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:10px 0 36px}.card{border:1px solid #333b3a;border-radius:16px;background:#191e20;padding:23px;min-width:0}
.label{color:#a7b2ae;font-size:12px;margin-bottom:13px}.value{font-size:24px;letter-spacing:-.6px}.small{font-size:12px;color:#9ca8a3;overflow-wrap:anywhere;margin-top:10px}
.section-title{display:flex;align-items:center;justify-content:space-between;gap:15px;margin:0 0 15px}.section-title h2{font-size:19px;font-weight:500;margin:0}.muted{color:#96a39d;font-size:12px}
.table-wrap{overflow:auto;border:1px solid #333b3a;border-radius:16px}table{width:100%;border-collapse:collapse;background:#191e20;font-size:13px;text-align:left}
th{padding:16px 20px;color:#aab4ad;font-weight:500;font-size:11px;letter-spacing:.7px;text-transform:uppercase;background:#202728}
td{padding:18px 20px;border-top:1px solid #303837;vertical-align:top;overflow-wrap:anywhere;max-width:300px}.mono{font-family:Consolas,monospace;font-size:12px}
button,.button{display:inline-block;background:#e6ad73;color:#191b1b;border:0;border-radius:9px;padding:12px 18px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none}
button.secondary{background:transparent;color:#c7d0cb;border:1px solid #414c47;padding:9px 15px}form{margin:0}
.notice{padding:18px 20px;border:1px solid #424a3c;border-radius:12px;color:#c0cbb5;background:#1d231e;margin:24px 0;font-size:13px;line-height:1.6}
footer{font-size:12px;color:#8b9890;padding-top:30px}.empty{padding:32px;color:#9fada5}.login{max-width:720px}.login .card{margin-top:12px;padding:30px}.tag{color:#e6bd91}
@media(max-width:700px){.shell{padding:24px 18px}.grid{grid-template-columns:1fr}.hero{padding-top:38px}td,th{padding:13px}.pill{font-size:10px}header{gap:10px}}
`;

function layout(title: string, body: string, nonce: string, logout?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Maru</title><style nonce="${nonce}">${css}</style></head><body><main class="shell"><header><a class="brand" href="/"><span class="mark">M</span>Maru<span class="pill">Development workspace</span></a>${logout ? `<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${escapeHtml(logout)}"><button class="secondary" type="submit">Sign out</button></form>` : '<span class="muted">Staff dashboard</span>'}</header>${body}<footer>Maru · Community management</footer></main></body></html>`;
}

export function loginPage(nonce: string): string {
  return layout('Sign in', `<div class="hero login"><div class="eyebrow">Your community, in view</div><h1>A home for your server staff.</h1><p>Sign in with Discord to view your Maru access and recent staff activity.</p></div><section class="card login"><h2>Welcome to Maru</h2><p>Access is limited to configured staff in Maru Development. Your current Discord roles determine what you can access.</p><a class="button" href="/auth/discord">Continue with Discord</a><p class="small">Sign-in requests your basic Discord profile. No email access is requested.</p></section>`, nonce);
}

export function messagePage(title: string, message: string, nonce: string): string {
  return layout(title, `<div class="hero"><div class="eyebrow">Staff dashboard</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="button" href="/">Back to sign in</a></div>`, nonce);
}

export type AuditRow = {
  event_id: string;
  event_type: string;
  actor_id: string;
  details: Record<string, unknown>;
  created_at: Date;
};

export function dashboardPage(data: {
  name: string; access: 'admin' | 'moderator'; guildId: string; botReady: boolean;
  events: AuditRow[]; csrf: string; nonce: string;
}): string {
  const rows = data.events.map((event) => {
    const reason = typeof event.details.reason === 'string' ? event.details.reason : '—';
    const target = event.details.target_user_id ?? event.details.role_id ?? '—';
    return `<tr><td><span class="tag">${escapeHtml(event.event_type.replaceAll('_', ' ').toLowerCase())}</span><div class="small">${escapeHtml(reason)}</div></td><td class="mono">${escapeHtml(event.actor_id)}</td><td class="mono">${escapeHtml(target)}</td><td>${escapeHtml(new Date(event.created_at).toISOString().replace('T', ' ').slice(0, 19))}</td></tr>`;
  }).join('');
  return layout('Overview', `<div class="hero"><div class="eyebrow">Workspace overview</div><h1>Welcome back, ${escapeHtml(data.name)}.</h1><p>Your access and the latest staff activity, together in one place.</p></div><div class="grid"><section class="card"><div class="label">Your Maru access</div><div class="value">${data.access === 'admin' ? 'Admin' : 'Moderator'}</div><div class="small">Verified against current Discord roles</div></section><section class="card"><div class="label">Bot connection</div><div class="value">${data.botReady ? 'Connected' : 'Reconnecting'}</div><div class="small">Database connection verified</div></section><section class="card"><div class="label">Server</div><div class="value">Maru Development</div><div class="small mono">${escapeHtml(data.guildId)}</div></section></div><div class="section-title"><h2>Recent staff activity</h2><span class="muted">Latest 20 events · UTC</span></div><div class="table-wrap"><table><thead><tr><th>Event and reason</th><th>Actor</th><th>Target</th><th>Time UTC</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">No staff activity recorded yet.</td></tr>'}</tbody></table></div><div class="notice">Use <strong>/staff-access</strong> in Discord to manage individual grants. Website configuration controls are coming in a later increment.</div>`, data.nonce, data.csrf);
}
