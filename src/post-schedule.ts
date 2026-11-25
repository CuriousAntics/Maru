export type PostSchedule = {kind:'once'|'interval'|'weekly'|'monthly';zone:string;start:string;fold:'earlier'|'later';minutes:number;weekdays:number[];monthDay:number};
export class ScheduleError extends Error {}
const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(zone:string){let f=formatters.get(zone);if(!f){try{f=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});f.format(0);}catch{throw new ScheduleError('Choose a valid timezone.');}if(formatters.size<1000)formatters.set(zone,f);}return f;}
export function localTime(instant:number,zone:string):string {const parts=Object.fromEntries(formatter(zone).formatToParts(instant).map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;}
function naive(local:string):number {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))throw new ScheduleError('Enter a date and time.');
  const ms=Date.parse(local+':00Z');if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,16)!==local||Number(local.slice(0,4))<2020||Number(local.slice(0,4))>2100)throw new ScheduleError('Enter a valid date from 2020 to 2100.');return ms;
}
export function resolveLocal(local:string,zone:string,fold:'earlier'|'later'='earlier'):number {
  const n=naive(local),offsets=new Set<number>();
  for(let h=-36;h<=36;h+=6){const sample=n+h*3600000;offsets.add(Date.parse(localTime(sample,zone)+':00Z')-sample);}
  const candidates=[...offsets].map(offset=>n-offset).filter(ms=>localTime(ms,zone)===local).sort((a,b)=>a-b);
  if(!candidates.length)throw new ScheduleError('That local time does not exist because the clocks change. Choose another time.');
  return (fold==='later'?candidates.at(-1):candidates[0])!;
}
export function validateSchedule(s:PostSchedule) {
  if(!s||!['once','interval','weekly','monthly'].includes(s.kind)||typeof s.zone!=='string'||!['earlier','later'].includes(s.fold)||!Number.isInteger(s.minutes)||s.minutes<1||s.minutes>525600||!Array.isArray(s.weekdays)||s.weekdays.length>7||new Set(s.weekdays).size!==s.weekdays.length||s.weekdays.some(d=>!Number.isInteger(d)||d<0||d>6)||!Number.isInteger(s.monthDay)||s.monthDay<1||s.monthDay>31||s.kind==='weekly'&&!s.weekdays.length)throw new ScheduleError('Check the repeat settings.');
  resolveLocal(s.start,s.zone,s.fold);
}
// Calendar repeats keep wall-clock time in their zone. Fixed intervals use elapsed minutes.
// Nonexistent spring-forward times and months without the selected date are skipped.
export function nextPostTime(s:PostSchedule,after:number):number|null {
  validateSchedule(s);const start=resolveLocal(s.start,s.zone,s.fold);
  if(s.kind==='once')return start>after?start:null;
  if(s.kind==='interval'){const step=s.minutes*60000;return start+Math.max(0,Math.floor((after-start)/step)+1)*step;}
  const date=localTime(Math.max(start,after),s.zone).slice(0,10),day=Date.parse(date+'T12:00:00Z'),clock=s.start.slice(11);
  for(let n=0;n<401;n++){
    const d=new Date(day+n*86400000),candidate=d.toISOString().slice(0,10)+'T'+clock;
    if(s.kind==='weekly'?!s.weekdays.includes(d.getUTCDay()):d.getUTCDate()!==s.monthDay)continue;
    try{const ms=resolveLocal(candidate,s.zone,s.fold);if(ms>=start&&ms>after)return ms;}catch(e){if(!(e instanceof ScheduleError))throw e;}
  }throw new ScheduleError('No occurrence found within the supported date range.');
}
