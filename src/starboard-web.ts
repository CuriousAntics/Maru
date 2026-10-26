import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { equal, logoutProof, starboardProof } from './web-security.js';
import { boardIdValid, loadStarboards, saveStarboard, StarboardSettingsError } from './starboard-settings.js';
import type { StarboardResources } from './starboard-settings.js';
import { starboardListPage, starboardFormPage, starboardErrorPage } from './starboard-pages.js';

type Views = {
  html: (status: number, render: (nonce: string) => string) => void;
  message: (status: number, title: string, text: string) => void;
  redirect: (path: string) => void;
};
export async function handleStarboardPage(request: IncomingMessage, path: string, options: {
  pool: Pick<Pool,'connect'|'query'>; guildId: string; actorId: string; sessionToken: string; origin: string;
  readMemberRoles: (id: string) => Promise<string[] | null>;
  readResources: () => Promise<StarboardResources>;
}, views: Views): Promise<void> {
  const { pool,guildId,actorId,sessionToken,readResources,readMemberRoles } = options;
  const match = /^\/starboards\/([^/]+)\/(create|save)$/.exec(path);
  try {
    if (request.method === 'POST' && match) {
      const boardId = match[1]!, action = match[2] as 'create' | 'save';
      if (!boardIdValid(boardId)) throw new StarboardSettingsError('INVALID_INPUT');
      if (request.headers.origin !== options.origin || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') {
        views.message(403,'Request rejected','Reload Starboard and use its form.'); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 32768) { views.message(413,'Request too large','Use the Starboard form with up to 100 source channels.'); return; }
        chunks.push(buffer);
      }
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const keys = ['csrf','revision','name','destination_id','emoji','threshold','allow_crosspost','enabled','reason'];
      if (keys.some((key) => params.getAll(key).length !== 1) || [...params.keys()].some((key) => ![...keys,'source_id'].includes(key))) throw new StarboardSettingsError('INVALID_INPUT');
      const revisionText = params.get('revision')!, thresholdText = params.get('threshold')!;
      if (!/^(0|[1-9]\d{0,9})$/.test(revisionText) || Number(revisionText) > 2147483647 || !/^[1-9]\d{0,3}$/.test(thresholdText) ||
          !['true','false'].includes(params.get('allow_crosspost')!) || !['true','false'].includes(params.get('enabled')!)) throw new StarboardSettingsError('INVALID_INPUT');
      const revision = Number(revisionText);
      if (!equal(params.get('csrf')!,starboardProof(sessionToken,boardId,revision,action))) {
        views.message(403,'Request rejected','Reload the board form before saving.'); return;
      }
      await saveStarboard(pool,{ guildId,actorId,sessionToken,boardId,action,revision,threshold: Number(thresholdText),
        name: params.get('name')!,destinationId: params.get('destination_id')!,emoji: params.get('emoji')!,sourceIds: params.getAll('source_id'),
        allowCrosspost: params.get('allow_crosspost') === 'true',enabled: params.get('enabled') === 'true',reason: params.get('reason')!,readResources,readMemberRoles });
      views.redirect(`/starboards/${boardId}`); return;
    }
    const boards = await loadStarboards(pool,guildId);
    const resources = await readResources();
    if (path === '/starboards') {
      views.html(200,(nonce) => starboardListPage({ boards,resources,nonce,logout: logoutProof(sessionToken) })); return;
    }
    const isNew = path === '/starboards/new';
    const id = isNew ? randomUUID() : path.slice('/starboards/'.length);
    const board = isNew ? undefined : boards.find((entry) => entry.board_id === id);
    if (!isNew && (!boardIdValid(id) || !board)) throw new StarboardSettingsError('BOARD_NOT_FOUND');
    views.html(200,(nonce) => starboardFormPage({ boardId: id,board,resources,nonce,logout: logoutProof(sessionToken),
      csrf: starboardProof(sessionToken,id,board?.revision ?? 0,board ? 'save' : 'create') }));
  } catch (error) {
    if (!(error instanceof StarboardSettingsError)) throw error;
    const errors: Record<string,[number,string]> = {
      WORKER_BUSY: [409,'Maru is updating highlights. Wait a moment, reload the board and save again.'],
      STAFF_REQUIRED: [403,'Your current roles no longer allow Starboard changes.'],
      SESSION_EXPIRED: [403,'Your session expired. Sign in again.'],
      SERVER_NOT_CONFIGURED: [409,'This server is not configured.'],
      BOARD_NOT_FOUND: [404,'No board with that ID exists in this server.'],
      STALE_BOARD: [409,'This board changed while the form was open. Reload it before saving.'],
      DUPLICATE_NAME: [409,'Choose a board name that is not already in use.'],
      BOARD_LIMIT: [409,'This server already has 25 boards. Edit an existing board.'],
      INVALID_NAME: [400,'Enter a board name from 1 to 60 characters.'],
      INVALID_REASON: [400,'Enter a reason from 1 to 500 characters.'],
      INVALID_THRESHOLD: [400,'Choose a reaction threshold from 1 to 1000.'],
      INVALID_SOURCES: [400,'Choose 1–100 distinct source channels. The destination cannot be a source for this board.'],
      CHANNEL_UNAVAILABLE: [400,'A chosen channel is unavailable or missing required bot permissions. Reload the form and check channel access.'],
      INVALID_EMOJI: [400,'Paste one Unicode emoji or a usable custom emoji from this server.'],
      EMOJI_UNAVAILABLE: [400,'That custom emoji is unavailable to Maru in this server. Choose another emoji.'],
      INVALID_INPUT: [400,'Reload Starboard and use its form.'],
    };
    const [status,text] = errors[error.code] ?? [400,'Reload Starboard and try again.'];
    views.html(status,(nonce) => starboardErrorPage(text,nonce,logoutProof(sessionToken)));
  }
}
