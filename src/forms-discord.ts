import { randomUUID } from 'node:crypto';
import { MessageFlags, ModalBuilder, REST, Routes } from 'discord.js';
import type { Interaction, APIModalInteractionResponseCallbackData, APILabelComponent, RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import type { Pool } from 'pg';
import { FormError, startForm, loadDraft, submitFormStep } from './forms.js';
import type { Entry, Answer, UploadedFile } from './forms.js';
import type { FormsDelivery } from './forms-worker.js';
export const nextFormButton = (e: Entry) => [{type:1 as const,components:[{type:2 as const,style:1 as const,label:e.step?'Continue':'Begin form',custom_id:`forms:next:${e.id}:${e.step}`}]}];
export function formModal(e: Entry) {
  const components: APILabelComponent[] = e.snapshot.questions.slice(e.step*5,(e.step+1)*5).map((q,n) => {
    const custom_id = 'q'+n;
    const base = {type:18 as const,label:q.label};
    if (q.type==='file') return {...base,description:'One file, up to 10 MiB. Up to 20 MiB for the whole form.',component:{type:19,custom_id,min_values:q.required?1:0,max_values:1,required:q.required}};
    if (q.type==='short'||q.type==='paragraph') return {...base,component:{type:4,custom_id,style:q.type==='short'?1:2,required:q.required,max_length:q.type==='short'?300:4000}};
    const options = q.options.map((label,index)=>({label,value:String(index)}));
    if (q.type==='choice') return {...base,component:{type:21,custom_id,options,required:q.required}};
    return {...base,component:{type:22,custom_id,options,required:q.required,min_values:q.required?1:0,max_values:options.length}};
  });
  const pages = Math.ceil(e.snapshot.questions.length/5);
  const suffix = pages>1?` (${e.step+1}/${pages})`:'';
  const data: APIModalInteractionResponseCallbackData = {custom_id:`forms:submit:${e.id}:${e.step}`,title:e.snapshot.title.slice(0,45-suffix.length)+suffix,components};
  return new ModalBuilder(data);
}
export async function downloadFormFile(url: string, size: number, fetcher: typeof fetch = fetch): Promise<Buffer> {
  const u = new URL(url);
  if (u.protocol!=='https:' || !['cdn.discordapp.com','media.discordapp.net'].includes(u.hostname) || u.port || u.username || u.password || !/^\/(?:ephemeral-)?attachments\//.test(u.pathname) || !Number.isInteger(size) || size<0 || size>10*1024*1024) throw new FormError('FILE_SIZE');
  const response = await fetcher(u,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!response.ok || !response.body) throw new FormError('FILE_DOWNLOAD');
  const reader = response.body.getReader(),chunks: Buffer[]=[]; let bytes=0;
  try {
    for (;;) { const {done,value}=await reader.read(); if (done) break; bytes+=value.byteLength; if (bytes>10*1024*1024 || bytes>size) throw new FormError('FILE_SIZE'); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel().catch(()=>{}); }
  if (bytes!==size) throw new FormError('FILE_DOWNLOAD');
  return Buffer.concat(chunks);
}
const messages: Record<string,string> = {
  CLOSED:'This form is closed or unavailable.',EXPIRED:'This draft expired or the form changed. Use the original post to start again.',STALE:'This section has already been saved or the form changed. Use the latest Continue button, or reopen the original post.',
  COOLDOWN:'Please wait one minute between submissions.',FILE_SIZE:'Files must be at most 10 MiB each and 20 MiB total. This section was not saved; reopen it with Continue and choose smaller files.',
  FILE_DOWNLOAD:'A file could not be saved. This section was not saved. Use Continue to try again.',INVALID_ANSWERS:'Check required answers and selections, then reopen this section with Continue.',
};
export async function handleFormInteraction(interaction: Interaction, pool: Pick<Pool,'query'|'connect'>, guildId: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!(interaction.isButton() || interaction.isModalSubmit()) || !interaction.customId.startsWith('forms:')) return false;
  if (interaction.guildId!==guildId || !interaction.member || interaction.user.bot) { await interaction.reply({content:'Open this form inside the server.',flags:MessageFlags.Ephemeral}); return true; }
  try {
    if (interaction.isButton()) {
      const start = /^forms:start:([0-9a-f-]{36})$/.exec(interaction.customId);
      if (start) {
        await interaction.deferReply({flags:MessageFlags.Ephemeral});
        const e = await startForm(pool,guildId,start[1]!,interaction.user.id);
        await interaction.editReply({content:`**${e.snapshot.title}**\n${e.snapshot.description}\n\n${e.snapshot.questions.length} questions. Only Maru staff can review your answers. Your Discord identity is included. Drafts last 24 hours. Nothing is submitted for review until the final section.`,components:nextFormButton(e),allowedMentions:{parse:[]}});
      } else {
        const next = /^forms:next:([0-9a-f-]{36}):([0-4])$/.exec(interaction.customId);
        if (!next) throw new FormError('EXPIRED');
        const e = await loadDraft(pool,guildId,next[1]!,interaction.user.id);
        if (e.step!==Number(next[2])) throw new FormError('STALE');
        await interaction.showModal(formModal(e));
      }
    } else {
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      const submit = /^forms:submit:([0-9a-f-]{36}):([0-4])$/.exec(interaction.customId);
      if (!submit) throw new FormError('EXPIRED');
      // An already recorded interaction can be acknowledged without downloading its files again.
      const repeated = (await pool.query<{state:string}>('SELECT e.state FROM form_steps s JOIN form_entries e ON e.guild_id=s.guild_id AND e.id=s.entry_id WHERE s.guild_id=$1 AND s.interaction_id=$2 AND e.id=$3 AND e.user_id=$4',[guildId,interaction.id,submit[1],interaction.user.id])).rows[0];
      if (repeated) { await interaction.editReply({content:repeated.state==='draft'?'This section is already saved. Reopen the original post to continue.':'Your submission is already saved.'}); return true; }
      const e = await loadDraft(pool,guildId,submit[1]!,interaction.user.id);
      if (e.step!==Number(submit[2])) throw new FormError('STALE');
      const questions=e.snapshot.questions.slice(e.step*5,(e.step+1)*5),answers: Answer[]=[],files: UploadedFile[]=[];
      for (const [n,q] of questions.entries()) {
        const key='q'+n;
        const a: Answer = {label:q.label,type:q.type,value:''};
        if (q.type==='short'||q.type==='paragraph') a.value=interaction.fields.getTextInputValue(key);
        else if (q.type==='choice') { const v=interaction.fields.getRadioGroup(key); a.value=v===null?[]:[q.options[Number(v)] ?? '']; }
        else if (q.type==='checkboxes') a.value=interaction.fields.getCheckboxGroup(key).map(v=>q.options[Number(v)] ?? '');
        else {
          const uploads=interaction.fields.getUploadedFiles(key);
          if (uploads && uploads.size>1) throw new FormError('INVALID_ANSWERS');
          const f=uploads?.first();
          if (f) { const id=randomUUID(); files.push({id,filename:f.name,data:await downloadFormFile(f.url,f.size,fetcher)}); a.fileId=id; a.filename=f.name; }
        }
        answers.push(a);
      }
      const saved=await submitFormStep(pool,{guildId,id:e.id,userId:interaction.user.id,step:e.step,interactionId:interaction.id,answers,files});
      await interaction.editReply(saved.state==='draft'?{content:'Section saved. Continue to the next section to finish your form.',components:nextFormButton(saved),allowedMentions:{parse:[]}}:{content:`Your form has been submitted. Reference: ${saved.id}. Staff will review it on Maru’s website. Maru will attempt to DM you their decision.`,components:[],allowedMentions:{parse:[]}});
    }
  } catch (error) {
    const content=error instanceof FormError ? messages[error.code] ?? 'This form could not be processed. Reopen the original post to continue.' : 'Maru could not confirm this step. Reopen the original post to check your saved progress.';
    if (interaction.deferred) await interaction.editReply({content,allowedMentions:{parse:[]}}).catch(()=>{});
    else if (!interaction.replied) await interaction.reply({content,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}}).catch(()=>{});
  }
  return true;
}
export function formsDelivery(token: string, readChannels: FormsDelivery['readChannels'], readRoles: FormsDelivery['readRoles']): FormsDelivery {
  const rest=new REST({version:'10',retries:0,timeout:15000}).setToken(token);
  async function send(channelId: string,body: RESTPostAPIChannelMessageJSONBody) {
    const result=await rest.post(Routes.channelMessages(channelId),{body,signal:AbortSignal.timeout(15000)}) as {id:string;channel_id:string};
    if (!/^\d{17,20}$/.test(result?.id) || result.channel_id!==channelId) throw new Error('INVALID_MESSAGE');
    return result.id;
  }
  return {readChannels,readRoles,post:send,dm:async(user,body)=>{
    const channel=await rest.post(Routes.userChannels(),{body:{recipient_id:user},signal:AbortSignal.timeout(15000)}) as {id:string};
    return send(channel.id,body);
  }};
}
