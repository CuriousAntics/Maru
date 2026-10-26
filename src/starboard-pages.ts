import { layout } from './web-pages.js';
import { escapeHtml } from './web-security.js';
import type { StarboardBoard, StarboardResources } from './starboard-settings.js';

export function starboardListPage(data: { boards: StarboardBoard[]; resources: StarboardResources; nonce: string; logout: string }): string {
  const channelName = (id: string) => {
    const channel = data.resources.channels.find((entry) => entry.id === id);
    return channel ? `#${channel.name}` : `Unavailable channel (${id})`;
  };
  const cards = data.boards.map((board) => `<section class="card"><h2>${escapeHtml(board.name)}</h2><p>${escapeHtml(board.emoji)} · ${board.threshold} reactions</p><p>Destination: ${escapeHtml(channelName(board.destination_channel_id))}</p><p class="small">${board.source_channel_ids.length} eligible channels · Cross-posting ${board.allow_crosspost ? 'allowed' : 'off'} · Revision ${board.revision}</p><a class="button" href="/starboards/${board.board_id}">Edit board</a></section>`).join('');
  return layout('Starboard',`<div class="hero"><div class="eyebrow">Community highlights</div><h1>Starboard</h1><p>Create separate boards for different reactions and channels.</p></div><div class="notice">Settings only: posting from reactions is not active yet. Existing Starboard posts remain untouched.</div><p><a class="button" href="/starboards/new">Create board</a></p><div class="grid">${cards || '<p>No boards configured yet.</p>'}</div>`,data.nonce,data.logout);
}
export function starboardFormPage(data: { boardId: string; board?: StarboardBoard; resources: StarboardResources; csrf: string; nonce: string; logout: string }): string {
  const { board,resources } = data;
  const id = board?.destination_channel_id;
  const options = resources.channels.filter((channel) => channel.destinationUsable || channel.id === id).map((channel) => `<option value="${channel.id}"${channel.id === id ? ' selected' : ''}>#${escapeHtml(channel.name)}${channel.destinationUsable ? '' : ' (missing bot permissions)'}</option>`).join('');
  const missing = id && !resources.channels.some((channel) => channel.id === id) ? `<option value="${id}" selected>Unavailable channel (${id})</option>` : '';
  const sourceIds = board?.source_channel_ids ?? [];
  const sources = resources.channels.map((channel) => {
    const selected = sourceIds.includes(channel.id);
    return `<label class="channel-choice"><input type="checkbox" name="source_id" value="${channel.id}"${selected ? ' checked' : ''}${!selected && !channel.sourceUsable ? ' disabled' : ''}>#${escapeHtml(channel.name)}${channel.sourceUsable ? '' : ' (missing bot permissions)'}</label>`;
  }).join('') + sourceIds.filter((sourceId) => !resources.channels.some((channel) => channel.id === sourceId)).map((sourceId) => `<label class="channel-choice"><input type="checkbox" name="source_id" value="${sourceId}" checked>Unavailable channel (${sourceId})</label>`).join('');
  const custom = resources.emojis.filter((emoji) => emoji.usable).map((emoji) => `<option value="&lt;${emoji.animated ? 'a' : ''}:${escapeHtml(emoji.name)}:${emoji.id}&gt;">${escapeHtml(emoji.name)}</option>`).join('');
  return layout(board ? 'Edit Starboard' : 'Create Starboard',`<div class="hero"><div class="eyebrow">Community highlights</div><h1>${board ? 'Edit board' : 'Create board'}</h1><p>Mods and Admins can manage Starboard settings.</p></div><div class="notice">Settings only: reaction posting is not active yet. Authors’ own reactions will not count. Posts will be removed when reactions fall below the threshold or the original message is deleted, and can be reposted if they qualify again.</div>${board ? `<p class="small" role="status">Saved configuration · Revision ${board.revision} · Last saved ${escapeHtml(new Date(board.updated_at).toISOString())}</p>` : ''}<section class="card"><form method="post" action="/starboards/${data.boardId}/${board ? 'save' : 'create'}"><input type="hidden" name="csrf" value="${escapeHtml(data.csrf)}"><input type="hidden" name="revision" value="${board?.revision ?? 0}">
    <label for="board_name">Board name</label><input id="board_name" name="name" required maxlength="60" value="${escapeHtml(board?.name ?? '')}" placeholder="Community highlights">
    <label for="destination_id">Destination channel</label><select id="destination_id" name="destination_id" required><option value=""${id ? '' : ' selected'}>Choose a channel</option>${missing}${options}</select><p class="small">Maru needs View Channel, Read Message History, Send Messages and Embed Links in the destination.</p>
    <label for="emoji">Reaction emoji</label><input id="emoji" name="emoji" list="emoji_suggestions" required maxlength="100" value="${escapeHtml(board?.emoji ?? '⭐')}"><datalist id="emoji_suggestions"><option value="⭐"><option value="🌟"><option value="❤️">${custom}</datalist><p class="small">Paste one Unicode emoji, or choose a server custom emoji. Custom emoji IDs and Discord &lt;:name:ID&gt; syntax are also accepted.</p>
    <label for="threshold">Reaction threshold</label><input id="threshold" name="threshold" type="number" min="1" max="1000" required value="${board?.threshold ?? 3}">
    <fieldset class="channel-choices"><legend>Eligible source channels (choose 1–100)</legend>${sources || '<p>No supported channels available.</p>'}</fieldset><p class="small">Sources need View Channel and Read Message History. Choose text or announcement channels; the destination cannot also be a source for this board. Messages from these sources will be visible in the destination when posting is added. Remove unavailable sources or restore bot access before saving.</p>
    <label for="allow_crosspost">Allow a source message on multiple boards?</label><select id="allow_crosspost" name="allow_crosspost"><option value="false"${board?.allow_crosspost ? '' : ' selected'}>No</option><option value="true"${board?.allow_crosspost ? ' selected' : ''}>Yes</option></select><p class="small">A message can appear on multiple boards only when each participating board allows sharing.</p>
    <label for="reason">Reason for change</label><textarea id="reason" name="reason" required maxlength="500" placeholder="Why are you creating or changing this board?"></textarea><button type="submit">${board ? 'Save board' : 'Create board'}</button></form></section><p><a href="/starboards">Back to boards</a></p>`,data.nonce,data.logout);
}

export function starboardErrorPage(text: string, nonce: string, logout: string): string {
  return layout('Starboard settings not saved', `<div class="hero"><h1>Settings not saved</h1><p role="alert">${escapeHtml(text)}</p><a class="button" href="/starboards">Back to Starboard</a></div>`,nonce,logout);
}
