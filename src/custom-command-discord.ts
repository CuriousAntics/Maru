import { REST, Routes } from 'discord.js';
import type { Client } from 'discord.js';
import type { CustomCommandSync, RemoteCommand } from './custom-command-sync.js';
export function customCommandSync(client: Client, guildId: string, token: string, override?: Pick<REST,'get'|'post'|'patch'|'delete'>): CustomCommandSync {
  const rest = override ?? new REST({ version:'10',retries:0,timeout:15000 }).setToken(token);
  const applicationId = () => { if (!client.user) throw new Error('BOT_NOT_READY'); return client.user.id; };
  const body = (name: string, description: string) => ({ name,description,type:1,options:[],default_member_permissions:null,nsfw:false });
  return {
    list: async () => await rest.get(Routes.applicationGuildCommands(applicationId(),guildId),{ signal:AbortSignal.timeout(15000) }) as RemoteCommand[],
    create: async (name,description) => await rest.post(Routes.applicationGuildCommands(applicationId(),guildId),{ body:body(name,description),signal:AbortSignal.timeout(15000) }) as RemoteCommand,
    edit: async (id,name,description) => await rest.patch(Routes.applicationGuildCommand(applicationId(),guildId,id),{ body:{name,description,options:[],default_member_permissions:null,nsfw:false},signal:AbortSignal.timeout(15000) }) as RemoteCommand,
    remove: async id => {
      try {
        const result = await rest.delete(Routes.applicationGuildCommand(applicationId(),guildId,id),{ signal:AbortSignal.timeout(15000) });
        if (result !== undefined && result !== null && !(result instanceof ArrayBuffer && result.byteLength === 0)) throw new Error('INVALID_DELETE_RESPONSE');
      } catch (e) { if (!(e && typeof e === 'object' && 'code' in e && Number(e.code) === 10063)) throw e; }
    },
  };
}
