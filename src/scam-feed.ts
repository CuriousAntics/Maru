import type { Pool } from 'pg';
import { normalizedDomain } from './message-links.js';
export const scamFeedSource='https://api.destroy.tools/v1/feed/primary.json';
export type ScamFeedStatus={ available: boolean; fetchedAt: string | null; domains: number; note: string };
export type ScamVerdict={ blocked: string[]; unknown: string[]; note: string };
export function createScamFeed(pool: Pick<Pool,'query'>,fetcher: typeof fetch=fetch,now: () => number=Date.now) {
 let domains=new Set<string>(),fetched=0,available=false,note='Feed not checked',work: Promise<void> | undefined;
 async function json(url: string,limit: number,timeout: number): Promise<Record<string,unknown>> {
 const response=await fetcher(url,{ redirect: 'error',signal: AbortSignal.timeout(timeout),headers: { Accept: 'application/json' } });
 if(!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('FEED_UNAVAILABLE');
 const chunks: Uint8Array[]=[]; let size=0;
 try { for await(const chunk of response.body) { size+=chunk.length; if(size>limit) throw new Error('FEED_TOO_LARGE'); chunks.push(chunk); } } catch(error) { await response.body.cancel().catch(() => {}); throw error; }
 const result=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
 if(!result || typeof result!=='object' || Array.isArray(result)) throw new Error('INVALID_FEED'); return result as Record<string,unknown>;
 }
 return {
 status: (): ScamFeedStatus => ({ available: available && now()-fetched<=3600000 && fetched<=now()+30000,fetchedAt: fetched?new Date(fetched).toISOString():null,domains: domains.size,note }),
 check: (values: string[]): ScamVerdict => {
 const usable=available && now()-fetched<=3600000 && fetched<=now()+30000;
 // Exact hostnames only: a listing never expands to every tenant under a hosting platform.
 return { blocked: usable?values.filter((d) => domains.has(d) || d.startsWith('www.') && domains.has(d.slice(4))):[],unknown: usable?values.filter((d) => !domains.has(d) && !(d.startsWith('www.') && domains.has(d.slice(4)))):values,note: usable?'Domain not listed; not verified safe':`${note}; feed unavailable or older than one hour` };
 },
 refresh: async () => {
 if(work) return work;
 work=(async () => {
 try {
 const health=await json('https://api.destroy.tools/v1/health',16384,5000);
 if(health.status!=='ok' || health.db!=='ok' || typeof health.sync_age_seconds!=='number' || health.sync_age_seconds<0 || health.sync_age_seconds>7200) throw new Error('FEED_HEALTH_UNCERTAIN');
 const data=await json(scamFeedSource,10*1024*1024,10000);
 if(data.list!=='primary' || !Array.isArray(data.domains) || data.domains.length<1 || data.domains.length>400000 || data.count!==data.domains.length || data.domains.some((d) => typeof d!=='string')) throw new Error('INVALID_FEED');
 const valid=data.domains.map((d) => normalizedDomain(d as string)).filter((d): d is string => !!d),next=new Set(valid);
 if(!next.size || typeof data.updated_at!=='string' || !Number.isFinite(Date.parse(data.updated_at)) || Date.parse(data.updated_at)>now()+30000) throw new Error('INVALID_FEED');
 const at=new Date(now());
 await pool.query(`INSERT INTO scam_feed_snapshot(source,domains,fetched_at,updated_at,skipped) VALUES ('phishdestroy_primary',$1,$2,$3,$4)
 ON CONFLICT(source) DO UPDATE SET domains=$1,fetched_at=$2,updated_at=$3,skipped=$4`,[[...next],at,new Date(data.updated_at),data.domains.length-valid.length]);
 domains=next; fetched=at.getTime(); available=true; note='PhishDestroy primary feed checked successfully';
 } catch { available=false; note='Feed check failed; automatic feed-based deletion paused'; }
 })().finally(() => { work=undefined; });
 return work;
 },
 };
}
export function startScamFeedWorker(pool: Pick<Pool,'query'>,guildId: string,service: ReturnType<typeof createScamFeed>,isReady: () => boolean) {
 let stopping=false,work: Promise<void> | undefined,lastAttempt=0;
 const timer=setInterval(() => {
 if(stopping || !isReady() || work || Date.now()-lastAttempt<900000) return;
 work=(async () => {
 const enabled=(await pool.query<{ scam_enabled: boolean }>('SELECT scam_enabled FROM automod_link_settings WHERE guild_id=$1',[guildId])).rows[0]?.scam_enabled;
 if(enabled) { lastAttempt=Date.now(); await service.refresh(); }
 })().catch(() => {}).finally(() => { work=undefined; });
 },1000); timer.unref();
 return { stop: async () => { stopping=true; clearInterval(timer); await work; } };
}
