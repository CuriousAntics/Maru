import type { CommunityInput } from './community-engine.js';
export type CommunityVoiceState={ userId: string; channelId: string; bot: boolean | null; muted: boolean; deafened: boolean; suppressed: boolean };
export function eligibleCommunityVoice(states: CommunityVoiceState[],afkIds: string[]) {
 const humanCounts=new Map<string,Set<string>>();
 for(const s of states) if(s.bot===false && !afkIds.includes(s.channelId)) { const ids=humanCounts.get(s.channelId) ?? new Set<string>(); ids.add(s.userId); humanCounts.set(s.channelId,ids); }
 return states.filter((s) => s.bot===false && !s.muted && !s.deafened && !s.suppressed && !afkIds.includes(s.channelId) && (humanCounts.get(s.channelId)?.size ?? 0)>=2).map((s) => ({ userId: s.userId,channelId: s.channelId }));
}
export function createCommunityVoiceClock() {
 let active=new Map<string,{ channelId: string; since: Date }>(),revision: number | undefined;
 return {
 reset: () => { active.clear(); revision=undefined; },
 sample: (members: { userId: string; channelId: string }[],nextRevision: number,at=new Date()): CommunityInput[] => {
 const events: CommunityInput[]=[];
 if(revision===nextRevision) for(const [userId,old] of active) {
 const elapsed=at.getTime()-old.since.getTime();
 if(elapsed>0 && elapsed<=30000) events.push({ kind: 'voice',userId,channelId: old.channelId,start: old.since,end: at,revision: nextRevision });
 }
 active=new Map(members.map((m) => [m.userId,{ channelId: m.channelId,since: at }])); revision=nextRevision;
 return events;
 } };
}
