import { ChannelType, PermissionFlagsBits, REST, Routes } from 'discord.js';
import type { APIGuildMember, APIUser, Client } from 'discord.js';
import type { CommunityResources } from './community-settings.js';
import type { CommunityDependencies, CommunityMember } from './community-engine.js';
import type { CommunityVoiceState } from './community-voice.js';
// Member roles must never grant staff powers through the engagement system.
const dangerous=[PermissionFlagsBits.Administrator,PermissionFlagsBits.ManageGuild,PermissionFlagsBits.ManageRoles,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ManageWebhooks,PermissionFlagsBits.BanMembers,PermissionFlagsBits.KickMembers,PermissionFlagsBits.ModerateMembers,PermissionFlagsBits.ManageMessages,PermissionFlagsBits.MentionEveryone,PermissionFlagsBits.ManageEvents,PermissionFlagsBits.ManageThreads,PermissionFlagsBits.ViewAuditLog,PermissionFlagsBits.ManageNicknames,PermissionFlagsBits.ManageGuildExpressions,PermissionFlagsBits.MuteMembers,PermissionFlagsBits.DeafenMembers,PermissionFlagsBits.MoveMembers];
export function communityResources(client: Client,guildId: string,eventsReady: boolean): () => Promise<CommunityResources> {
 return async () => {
 const guild=await client.guilds.fetch({ guild: guildId,force: true }),roles=await guild.roles.fetch(),me=await guild.members.fetchMe({ force: true }),channels=await guild.channels.fetch();
 return { eventsReady,roles: [...roles.values()].filter((r) => r.id!==guildId).map((r) => ({ id: r.id,name: r.name,usable: !r.managed && me.permissions.has(PermissionFlagsBits.ManageRoles) && me.roles.highest.comparePositionTo(r)>0 && !dangerous.some((p) => r.permissions.has(p)) })),
 channels: [...channels.values()].flatMap((c) => c && (c.isTextBased() || [ChannelType.GuildForum,ChannelType.GuildMedia].includes(c.type))?[{ id: c.id,name: c.name }]:[]),
 voiceChannels: [...channels.values()].flatMap((c) => c?.isVoiceBased()?[{ id: c.id,name: c.name }]:[]) };
 };
}
export function communityDependencies(client: Client,guildId: string,token: string,override?: Pick<REST,'get'|'put'|'delete'>): CommunityDependencies {
 const rest=override ?? new REST({ version: '10',retries: 0,timeout: 15000 }).setToken(token);
 function parse(m: APIGuildMember & { user?: APIUser }): CommunityMember {
 if(!/^\d{17,20}$/.test(m.user?.id ?? '') || !Array.isArray(m.roles) || m.roles.some((r) => !/^\d{17,20}$/.test(r)) || typeof m.user?.bot!=='boolean' && m.user?.bot!==undefined) throw new Error('INVALID_MEMBER');
 return { id: m.user!.id,roles: m.roles,bot: !!m.user!.bot };
 }
 function empty(value: unknown) { if(value!==undefined && value!==null && !(value instanceof ArrayBuffer && !value.byteLength)) throw new Error('ROLE_RESPONSE_UNCONFIRMED'); }
 return { botId: () => { if(!client.user) throw new Error('BOT_NOT_READY'); return client.user.id; },
 readMember: async (id) => { try { const m=parse(await rest.get(Routes.guildMember(guildId,id),{ signal: AbortSignal.timeout(15000) }) as APIGuildMember); if(m.id!==id) throw new Error('MEMBER_MISMATCH'); return m; }
 catch(e) { if(e && typeof e==='object' && 'code' in e && Number(e.code)===10007) return null; throw e; } },
 roleUsable: async (role) => (await communityResources(client,guildId,true)()).roles.some((r) => r.id===role && r.usable),
 addRole: async (user,role) => empty(await rest.put(Routes.guildMemberRole(guildId,user,role),{ reason: 'Maru Community / Nomad assignment',signal: AbortSignal.timeout(15000) })),
 removeRole: async (user,role) => empty(await rest.delete(Routes.guildMemberRole(guildId,user,role),{ reason: 'Maru Community replaces Nomad',signal: AbortSignal.timeout(15000) })),
 listMembers: async (after) => { const page=await rest.get(Routes.guildMembers(guildId),{ query: new URLSearchParams({ limit: '1000',after }),signal: AbortSignal.timeout(15000) }); if(!Array.isArray(page)) throw new Error('INVALID_MEMBER_PAGE'); return page.map(parse); },
 };
}
export function communityVoiceSnapshot(client: Client,guildId: string): { states: CommunityVoiceState[]; afk: string | null } {
 const guild=client.guilds.cache.get(guildId); if(!guild?.available) return { states: [],afk: null };
 return { afk: guild.afkChannelId,states: [...guild.voiceStates.cache.values()].flatMap((v) => v.channelId?[{ userId: v.id,channelId: v.channelId,bot: v.member?v.member.user.bot:null,muted: v.mute!==false,deafened: v.deaf!==false,suppressed: !!v.suppress }]:[]) };
}
