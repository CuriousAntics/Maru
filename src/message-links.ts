import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
export type MessageLink={ key: string; domain: string };
export function normalizedDomain(text: string): string | null {
 const raw=text.trim().toLowerCase().replace(/[\u3002\uFF0E\uFF61]/g,'.').replace(/\.$/,'');
 if(!/^[\p{L}\p{N}\p{M}.-]+$/u.test(raw)) return null;
 const domain=domainToASCII(raw);
 if(!domain || domain.length>253 || !domain.includes('.') || domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+(?:\.\d+){3}$/.test(domain)) return null;
 return domain;
}
export function parseDomainList(text: string): string[] {
 const values=text.split(/[,\s]+/).filter(Boolean); const parsed=values.map(normalizedDomain);
 if(values.length>100 || parsed.some((v) => !v)) throw new Error('INVALID_DOMAINS');
 return [...new Set(parsed as string[])].sort();
}
export function messageLinks(text: string): MessageLink[] {
 const results=new Map<string,MessageLink>();
 const pattern=/(?<![\p{L}\p{N}_@./\\-])(?:https?:\/\/|www\.)[^\s<>"`]+/giu;
 for(const match of text.replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').matchAll(pattern)) {
 let raw=match[0].replace(/[.,!?;:]+$/,'');
 for(const [open,close] of [['(',')'],['[',']'],['{','}']]) while(raw.endsWith(close!) && raw.split(close!).length>raw.split(open!).length) raw=raw.slice(0,-1);
 try {
 const url=new URL(/^www\./i.test(raw)?`https://${raw}`:raw); if(!['http:','https:'].includes(url.protocol) || !url.hostname) continue;
 url.hostname=url.hostname.toLowerCase().replace(/\.$/,''); url.hash=''; url.username=''; url.password='';
 const domain=normalizedDomain(url.hostname) ?? url.hostname;
 const key=createHash('sha256').update(url.href).digest('hex'); results.set(key,{ key,domain }); if(results.size>=100) break;
 } catch { /* Malformed URLs never imply a violation. */ }
 }
 return [...results.values()];
}
