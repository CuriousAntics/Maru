import type { Pool } from 'pg';
import { readCommunitySettings } from './community-settings.js';
import type { CommunitySettings } from './community-settings.js';
import { ingestCommunity, processCommunityRole, processCommunityCapture } from './community-engine.js';
import type { CommunityInput, CommunityDependencies } from './community-engine.js';
import { createCommunityVoiceClock, eligibleCommunityVoice } from './community-voice.js';
import type { CommunityVoiceState } from './community-voice.js';
export function parseCommunityPacket(packet: { t?: string | null; d: unknown },guildId: string,revision: number): CommunityInput | undefined {
 const d=packet.d as { guild_id?: string; id?: string; channel_id?: string; timestamp?: string; type?: number; author?: { id?: string; bot?: boolean }; user?: { id?: string; bot?: boolean }; webhook_id?: string } | null;
 if(!d || d.guild_id!==guildId) return;
 if(['GUILD_MEMBER_ADD','GUILD_MEMBER_UPDATE'].includes(packet.t ?? '')) { if(d.user?.id && /^\d{17,20}$/.test(d.user.id) && !d.user.bot) return { kind: 'member',userId: d.user.id,at: new Date(),revision }; return; }
 if(packet.t!=='MESSAGE_CREATE' || d.webhook_id || d.author?.bot || ![0,19].includes(d.type ?? 0) || ![d.id,d.channel_id,d.author?.id].every((id) => /^\d{17,20}$/.test(id ?? ''))) return;
 const at=new Date(d.timestamp ?? ''); if(!Number.isFinite(at.getTime()) || at.getTime()<Date.now()-120000 || at.getTime()>Date.now()+30000) return;
 return { kind: 'message',userId: d.author!.id!,messageId: d.id!,channelId: d.channel_id!,at,revision };
}
export function startCommunityWorker(pool: Pick<Pool,'query'|'connect'>,guildId: string,deps: CommunityDependencies,options: {
 isReady: () => boolean; snapshot: () => { states: CommunityVoiceState[]; afk: string | null }; readParent: (id: string) => Promise<string | null>;
}) {
 let settings: CommunitySettings | undefined,stopping=false,work: Promise<void> | undefined;
 let pending: CommunityInput[]=[],lastSample=0,lastCapture=0; const clock=createCommunityVoiceClock();
 function queue(values: CommunityInput[]) { if(pending.length+values.length>5000) { console.error('Community activity intake is full; a sample could not be queued.'); return; } pending.push(...values); }
 function sample() {
 if(!options.isReady() || !settings?.tracking_enabled) { clock.reset(); return; }
 const snapshot=options.snapshot(); queue(clock.sample(eligibleCommunityVoice(snapshot.states,[...settings.afk_channel_ids,...(snapshot.afk?[snapshot.afk]:[])]),settings.revision));
 lastSample=Date.now();
 }
 async function tick() {
 if(stopping || !options.isReady()) { clock.reset(); return; }
 const next=await readCommunitySettings(pool,guildId);
 if(next.revision!==settings?.revision) clock.reset(); settings=next;
 if(Date.now()-lastSample>=15000) sample();
 const batch=pending.slice(0,100);
 if(batch.length) {
 const resolved: CommunityInput[]=[];
 for(const ev of batch) { try { resolved.push(ev.kind==='message'?{ ...ev,parentId: await options.readParent(ev.channelId!) }:ev); } catch { console.error('Community message channel could not be verified; no credit recorded.'); } }
 await ingestCommunity(pool,guildId,resolved,deps.botId()); pending.splice(0,batch.length);
 }
 for(let i=0;i<5 && !stopping;i++) if(!await processCommunityRole(pool,guildId,deps)) break;
 if(Date.now()-lastCapture>5000) { lastCapture=Date.now(); await processCommunityCapture(pool,guildId,deps); }
 }
 const timer=setInterval(() => {
 if(!work) work=tick().catch(() => console.error('Community activity is waiting for Discord or PostgreSQL; queued samples will retry.')).finally(() => { work=undefined; });
 },1000); timer.unref();
 return {
 accept: (packet: { t?: string | null; d: unknown }) => { if(stopping || !options.isReady() || !settings || !settings.tracking_enabled && !settings.roles_enabled) return;
 const ev=parseCommunityPacket(packet,guildId,settings.revision); if(ev) queue([ev]); },
 voiceChanged: () => { if(!stopping) sample(); },
 resetVoice: () => { clock.reset(); },
 stop: async () => { stopping=true; clearInterval(timer); await work; clock.reset();
 // Do not credit shutdown or offline time. Save already closed samples only.
 while(pending.length) { const batch=pending.slice(0,100),resolved: CommunityInput[]=[]; for(const ev of batch) { try { resolved.push(ev.kind==='message'?{ ...ev,parentId: await options.readParent(ev.channelId!) }:ev); } catch { /* Unverified channels receive no credit. */ } } await ingestCommunity(pool,guildId,resolved,deps.botId()); pending.splice(0,batch.length); }
 },
 };
}
