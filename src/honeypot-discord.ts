import { ChannelType, PermissionFlagsBits, REST, Routes } from 'discord.js';
import type { APIBan, APIMessage, Client } from 'discord.js';
import type { WarningDependencies } from './warnings.js';
import type { HoneypotResources } from './honeypot-settings.js';
import type { HoneypotDependencies } from './honeypot-engine.js';
const missingMember=(e: unknown) => !!e && typeof e==='object' && 'code' in e && Number(e.code)===10007;
export function honeypotResources(client: Client,guildId: string): () => Promise<HoneypotResources> {
  return async () => {
    const guild=await client.guilds.fetch({ guild: guildId,force: true });
    const roles=await guild.roles.fetch(),me=await guild.members.fetchMe({ force: true }),channels=await guild.channels.fetch();
    return { canBan: me.permissions.has(PermissionFlagsBits.BanMembers),
      roles: [...roles.values()].filter((r) => r.id!==guildId).map((r) => ({ id: r.id,name: r.name })),
      channels: [...channels.values()].flatMap((c) => c && c.type===ChannelType.GuildText?[{ id: c.id,name: c.name,usable: c.permissionsFor(me).has(PermissionFlagsBits.ViewChannel) }]:[]) };
  };
}
export function honeypotDependencies(client: Client,guildId: string,token: string,notifications: WarningDependencies,
  override?: Pick<REST,'get'|'put'|'delete'|'post'>): HoneypotDependencies {
  const writer=override ?? new REST({ version: '10',retries: 0,timeout: 15000 }).setToken(token);
  const readBan: HoneypotDependencies['readBan']=async (id) => {
    try {
      const ban=await writer.get(Routes.guildBan(guildId,id),{ signal: AbortSignal.timeout(15000) }) as APIBan;
      if(ban.user?.id!==id || ban.reason!==null && typeof ban.reason!=='string') throw new Error('INVALID_BAN_RESPONSE');
      return { reason: ban.reason };
    } catch(error) {
      if(error && typeof error==='object' && 'code' in error && Number(error.code)===10026) return null;
      throw error;
    }
  };
  function empty(result: unknown) {
    if(result!==undefined && result!==null && !(result instanceof ArrayBuffer && result.byteLength===0)) throw new Error('UNEXPECTED_RESPONSE');
  }
  return {
    botId: () => { if(!client.user) throw new Error('BOT_NOT_READY'); return client.user.id; },readBan,
    readContext: async (id) => {
      const guild=await client.guilds.fetch({ guild: guildId,force: true }); await guild.roles.fetch();
      const me=await guild.members.fetchMe({ force: true });
      const target=await guild.members.fetch({ user: id,force: true }).catch((e: unknown) => { if(missingMember(e)) return null; throw e; });
      return { guildName: guild.name,member: !!target,bot: target?.user.bot ?? false,owner: id===guild.ownerId,
        administrator: target?.permissions.has(PermissionFlagsBits.Administrator) ?? false,roles: target?[...target.roles.cache.keys()]:[],
        canBan: me.permissions.has(PermissionFlagsBits.BanMembers),above: !!target && me.roles.highest.comparePositionTo(target.roles.highest)>0 };
    },
    ban: async (id,reason) => { empty(await writer.put(Routes.guildBan(guildId,id),{ body: { delete_message_seconds: 86400 },reason,signal: AbortSignal.timeout(15000) })); },
    unban: async (id,reason) => {
      // Recheck ownership immediately before DELETE, including during restart recovery.
      const current=await readBan(id); if(!current) return;
      if(current.reason!==reason) throw new Error('BAN_OWNERSHIP_CHANGED');
      empty(await writer.delete(Routes.guildBan(guildId,id),{ reason: `${reason} completed`,signal: AbortSignal.timeout(15000) }));
    },
    notifications: { ...notifications,sendLog: async (channel,body) => {
      const message=await writer.post(Routes.channelMessages(channel),{ body,signal: AbortSignal.timeout(15000) }) as APIMessage;
      if(message.channel_id!==channel || !/^\d{17,20}$/.test(message.id ?? '')) throw new Error('INVALID_LOG_RESPONSE');
      return { id: message.id };
    } },
  };
}
