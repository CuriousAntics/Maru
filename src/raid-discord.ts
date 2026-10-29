import { PermissionFlagsBits, PermissionsBitField, REST, Routes } from 'discord.js';
import type { Client, Guild, GuildMember, APIGuildMember, APIInvite, APIBan, APIUser } from 'discord.js';
import { RaidError } from './raid-settings.js';
import type { RaidDependencies, RaidMember } from './raid-settings.js';
export function raidDependencies(client: Client,guildId: string,token: string,membersReady: boolean,override?: Pick<REST,'get'|'put'|'delete'>): RaidDependencies {
 const rest=override ?? new REST({ version: '10',retries: 0,timeout: 15000 }).setToken(token);
 const options=() => ({ signal: AbortSignal.timeout(15000) });
 async function context(actor: string) {
 const guild=await client.guilds.fetch({ guild: guildId,force: true }); await guild.roles.fetch();
 const staff=await guild.members.fetch({ user: actor,force: true }),me=await guild.members.fetchMe({ force: true });
 return { guild,staff,me };
 }
 function member(raw: APIGuildMember & { user?: APIUser },ctx: { guild: Guild; staff: GuildMember; me: GuildMember }): RaidMember {
 if(!/^\d{17,20}$/.test(raw.user?.id ?? '') || !Array.isArray(raw.roles) || raw.roles.some((r) => !ctx.guild.roles.cache.has(r)) || !raw.joined_at || !Number.isFinite(new Date(raw.joined_at).getTime())) throw new RaidError('INVALID_MEMBER');
 const roleList=raw.roles.map((id) => ctx.guild.roles.cache.get(id)!);
 const highest=roleList.reduce((best,r) => r.comparePositionTo(best)>0?r:best,ctx.guild.roles.everyone);
 const permissions=new PermissionsBitField(ctx.guild.roles.everyone.permissions.bitfield); for(const r of roleList) permissions.add(r.permissions);
 return { id: raw.user!.id,name: (raw.nick ?? raw.user!.global_name ?? raw.user!.username ?? raw.user!.id).slice(0,100),roles: raw.roles,joinedAt: new Date(raw.joined_at).toISOString(),
 bot: !!raw.user!.bot,owner: raw.user!.id===ctx.guild.ownerId,administrator: permissions.has(PermissionFlagsBits.Administrator),
 staffPermissions: [PermissionFlagsBits.ManageGuild,PermissionFlagsBits.ManageRoles,PermissionFlagsBits.BanMembers,PermissionFlagsBits.KickMembers,PermissionFlagsBits.ModerateMembers].some((p) => permissions.has(p)),
 actorAbove: ctx.staff.id===ctx.guild.ownerId || ctx.staff.roles.highest.comparePositionTo(highest)>0,botAbove: ctx.me.roles.highest.comparePositionTo(highest)>0 };
 }
 const readInvite: RaidDependencies['readInvite']=async (code) => {
 try {
 const invite=await rest.get(Routes.invite(code),options()) as APIInvite;
 if(invite.code!==code || invite.guild?.id!==guildId || !/^\d{17,20}$/.test(invite.channel?.id ?? '')) throw new RaidError('FOREIGN_OR_INVALID_INVITE');
 const guild=await client.guilds.fetch({ guild: guildId,force: true }); if(guild.vanityURLCode===code) throw new RaidError('VANITY_UNSUPPORTED');
 return { code,guildId,channelId: invite.channel!.id };
 } catch(e) { if(e && typeof e==='object' && 'code' in e && Number(e.code)===10006) return null; throw e; }
 };
 return { membersReady,botId: () => { if(!client.user) throw new RaidError('BOT_NOT_READY'); return client.user.id; },
 readActor: async (id) => { const { guild,staff,me }=await context(id); return { roles: [...staff.roles.cache.keys()],canBan: staff.permissions.has(PermissionFlagsBits.BanMembers),botCanBan: me.permissions.has(PermissionFlagsBits.BanMembers),guildName: guild.name }; },
 listMembers: async (after,actor) => {
 const ctx=await context(actor),page=await rest.get(Routes.guildMembers(guildId),{ ...options(),query: new URLSearchParams({ limit: '1000',after }) });
 if(!Array.isArray(page)) throw new RaidError('INVALID_MEMBER_PAGE'); return page.map((m) => member(m,ctx));
 },
 readMember: async (id,actor) => {
 try { const ctx=await context(actor); const m=member(await rest.get(Routes.guildMember(guildId,id),options()) as APIGuildMember,ctx); if(m.id!==id) throw new RaidError('INVALID_MEMBER'); return m; }
 catch(e) { if(e && typeof e==='object' && 'code' in e && Number(e.code)===10007) return null; throw e; }
 },readInvite,
 canRevoke: async (actor,channelId) => {
 const { guild,staff,me }=await context(actor),channel=await guild.channels.fetch(channelId,{ force: true });
 return !!channel && (staff.permissions.has(PermissionFlagsBits.ManageGuild) || !!channel.permissionsFor(staff)?.has(PermissionFlagsBits.ManageChannels)) &&
 (me.permissions.has(PermissionFlagsBits.ManageGuild) || !!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels));
 },
 revokeInvite: async (code,run,channel) => {
 const before=await readInvite(code); if(!before) return; if(before.channelId!==channel) throw new RaidError('INVITE_CHANGED');
 const result=await rest.delete(Routes.invite(code),{ ...options(),reason: `Maru raid response ${run}` }) as APIInvite;
 if(result?.code!==code || result.guild?.id!==guildId) throw new RaidError('INVITE_RESPONSE_UNCONFIRMED');
 },
 readBan: async (id) => {
 try { const ban=await rest.get(Routes.guildBan(guildId,id),options()) as APIBan; if(ban.user?.id!==id || ban.reason!==null && typeof ban.reason!=='string') throw new RaidError('INVALID_BAN'); return { reason: ban.reason }; }
 catch(e) { if(e && typeof e==='object' && 'code' in e && Number(e.code)===10026) return null; throw e; }
 },
 ban: async (id,seconds,marker) => {
 const result=await rest.put(Routes.guildBan(guildId,id),{ ...options(),reason: marker,body: { delete_message_seconds: seconds } });
 if(result!==null && result!==undefined && !(result instanceof ArrayBuffer && result.byteLength===0)) throw new RaidError('BAN_RESPONSE_UNCONFIRMED');
 },
 };
}
