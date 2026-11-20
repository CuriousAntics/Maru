import type { Pool } from 'pg';
import type { CustomCommand } from './custom-commands.js';
import { customName } from './custom-commands.js';
export type RemoteCommand = { id: string; name: string; type: number };
export type CustomCommandSync = {
  list: () => Promise<RemoteCommand[]>;
  create: (name: string, description: string) => Promise<RemoteCommand>;
  edit: (id: string, name: string, description: string) => Promise<RemoteCommand>;
  remove: (id: string) => Promise<void>;
};
const valid = (c: RemoteCommand) => c && /^\d{17,20}$/.test(c.id) && typeof c.name === 'string' && Number.isInteger(c.type);
export async function syncCustomCommand(pool: Pick<Pool,'connect'>, guildId: string, deps: CustomCommandSync): Promise<boolean> {
  const db = await pool.connect(); let discard = false;
  let row: CustomCommand | undefined;
  try {
    await db.query('BEGIN');
    // An interrupted network operation is visible for review, never blindly repeated after restart.
    await db.query(`UPDATE custom_commands SET sync_status='error',sync_note='Synchronization interrupted. Save again to retry; an uncertain creation may require a different name.'
      WHERE guild_id=$1 AND sync_status='running' AND sync_started_at<NOW()-INTERVAL '1 minute'`,[guildId]);
    row = (await db.query<CustomCommand>(`SELECT * FROM custom_commands WHERE guild_id=$1 AND sync_status='pending'
      ORDER BY updated_at,name FOR UPDATE SKIP LOCKED LIMIT 1`,[guildId])).rows[0];
    if (!row) { await db.query('COMMIT'); return false; }
    if (!customName(row.name)) throw new Error('RESERVED_COMMAND');
    await db.query("UPDATE custom_commands SET sync_status='running',sync_note='Synchronizing with Discord',sync_started_at=NOW() WHERE guild_id=$1 AND name=$2",[guildId,row.name]);
    await db.query('COMMIT');
    let status: 'synced'|'error' = 'synced', note = row.enabled ? 'Available in Discord' : 'Off; not registered in Discord';
    let remoteId = row.discord_id;
    try {
      const commands = await deps.list();
      if (!Array.isArray(commands) || commands.some(c => !valid(c))) throw new Error('INVALID_REMOTE_COMMANDS');
      const owned = remoteId ? commands.find(c => c.id === remoteId) : undefined;
      if (owned && (owned.name !== row.name || owned.type !== 1)) throw new Error('OWNERSHIP_CHANGED');
      if (!row.enabled || row.deleted) {
        // Never delete by name. Only remove the exact command ID previously confirmed for this row.
        if (owned) await deps.remove(owned.id);
        remoteId = null;
      } else {
        let result: RemoteCommand;
        if (owned) result = await deps.edit(owned.id,row.name,row.description);
        else {
          if (commands.some(c => c.type === 1 && c.name === row!.name)) throw new Error('NAME_CONFLICT');
          result = await deps.create(row.name,row.description);
        }
        if (!valid(result) || result.type !== 1 || result.name !== row.name || owned && result.id !== owned.id) throw new Error('INVALID_SYNC_RESPONSE');
        remoteId = result.id;
      }
    } catch (error) {
      status = 'error';
      note = error instanceof Error && error.message === 'NAME_CONFLICT'
        ? 'A command with this name already exists and is not owned by this entry. Choose a different name.'
        : 'Discord synchronization not confirmed. Save again to retry. An uncertain creation may require a different name.';
    }
    await db.query(`UPDATE custom_commands SET discord_id=$3,sync_status=$4,sync_note=$5,sync_started_at=NULL
      WHERE guild_id=$1 AND name=$2 AND revision=$6 AND sync_status='running'`,[guildId,row.name,remoteId,status,note,row.revision]);
    return true;
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { db.release(discard ? new Error('Custom command sync connection unavailable') : undefined); }
}
export function startCustomCommandWorker(pool: Pick<Pool,'connect'>, guildId: string, deps: CustomCommandSync, ready: () => boolean) {
  let stopping = false, work: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (stopping || work || !ready()) return;
    work = syncCustomCommand(pool,guildId,deps).catch(() => console.error('Custom command synchronization is waiting for saved work.')).finally(() => { work = undefined; });
  },5000); timer.unref();
  return { stop: async () => { stopping = true; clearInterval(timer); await work; } };
}
