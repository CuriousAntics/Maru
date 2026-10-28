import type { Pool } from 'pg';
import { enqueueHoneypot, parseHoneypotEvent, processHoneypotJob } from './honeypot-engine.js';
import type { HoneypotEvent, HoneypotDependencies } from './honeypot-engine.js';
export function startHoneypotWorker(pool: Pick<Pool,'query'|'connect'>,guildId: string,deps: HoneypotDependencies,isReady: () => boolean) {
  const pending=new Map<string,HoneypotEvent>(); let stopping=false;
  let intake: Promise<void> | undefined,work: Promise<void> | undefined;
  async function flush() {
    const events=[...pending.values()].slice(0,100); if(!events.length) return;
    await enqueueHoneypot(pool,guildId,events);
    for(const event of events) if(pending.get(event.messageId)===event) pending.delete(event.messageId);
  }
  function tick() {
    if(stopping || !isReady()) return;
    if(!intake && pending.size) intake=flush().catch(() => console.error('Honeypot intake is waiting for PostgreSQL.')).finally(() => { intake=undefined; });
    if(!work) work=(async () => {
      const due=await pool.query(`SELECT 1 FROM honeypot_events e LEFT JOIN moderation_cases c ON c.guild_id=e.guild_id AND c.case_number=e.case_number
        WHERE e.guild_id=$1 AND e.available_at<=NOW() AND (NOT e.done OR (c.notification_claimed_at IS NULL AND c.action_status IN ('applied','rejected','unconfirmed'))) LIMIT 1`,[guildId]);
      if(!due.rowCount) return;
      for(let i=0;i<5 && !stopping && isReady();i++) if(!await processHoneypotJob(pool,guildId,deps)) break;
    })().catch(() => console.error('Honeypot worker will retry saved work.')).finally(() => { work=undefined; });
  }
  const timer=setInterval(tick,500); timer.unref();
  return { accept: (packet: { t?: string | null; d: unknown }) => {
    if(stopping) return; const event=parseHoneypotEvent(packet,guildId); if(!event) return;
    if(pending.size>=5000 && !pending.has(event.messageId)) { console.error('Honeypot intake is full; an event could not be queued.'); return; }
    pending.set(event.messageId,event);
  },stop: async () => { stopping=true; clearInterval(timer); await intake; while(pending.size) await flush(); await work; } };
}
