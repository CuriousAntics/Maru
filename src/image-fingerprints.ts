import { createHash } from 'node:crypto';
export type AutoModImage={ id: string; url: string; size: number };
export type ImageFingerprints={ hashes: string[]; skipped: boolean };
export const imageByteLimit=25*1024*1024,messageImageByteLimit=50*1024*1024;
export function trustedImageUrl(image: AutoModImage,channelId: string): URL | null {
  try {
    const url=new URL(image.url);
    if(url.protocol!=='https:' || url.hostname!=='cdn.discordapp.com' || url.port || url.username || url.password || url.hash ||
      !/^\d{17,20}$/.test(channelId) || !/^\d{17,20}$/.test(image.id) ||
      !url.pathname.startsWith(`/attachments/${channelId}/${image.id}/`) || url.pathname.split('/').length!==5 || !url.pathname.split('/')[4]) return null;
    return url;
  } catch { return null; }
}
export function createImageFingerprinter(fetcher: typeof fetch=fetch) {
  const cache=new Map<string,{ hash: string; expires: number }>();
  return async (source: { channelId: string; images?: AutoModImage[] }): Promise<ImageFingerprints> => {
    const hashes=new Set<string>(); let skipped=false,budget=0; const end=Date.now()+12000;
    for(const [index,image] of (source.images ?? []).entries()) {
      const url=trustedImageUrl(image,source.channelId);
      if(index>=10 || !url || !Number.isSafeInteger(image.size) || image.size<1 || image.size>imageByteLimit || budget+image.size>messageImageByteLimit) { skipped=true; continue; }
      budget+=image.size;
      const key=`${source.channelId}:${image.id}:${image.size}`,cached=cache.get(key);
      if(cached && cached.expires>Date.now()) { hashes.add(cached.hash); continue; }
      if(end-Date.now()<=0) { skipped=true; continue; }
      const controller=new AbortController(); let response: Response | undefined; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        response=await fetcher(url,{ redirect: 'error',signal: AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,Math.min(8000,end-Date.now())))]),headers: { 'accept-encoding': 'identity' } });
        const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
        if(response.status!==200 || !response.body || length!==null && Number(length)!==image.size || encoding && encoding!=='identity') throw new Error('IMAGE_UNAVAILABLE');
        reader=response.body.getReader(); const hash=createHash('sha256'); let bytes=0;
        while(true) {
          const chunk=await reader.read(); if(chunk.done) break;
          bytes+=chunk.value.byteLength; if(bytes>image.size || bytes>imageByteLimit || Date.now()>end) throw new Error('IMAGE_LIMIT');
          hash.update(chunk.value);
        }
        if(bytes!==image.size) throw new Error('IMAGE_INCOMPLETE');
        const fingerprint=hash.digest('hex'); hashes.add(fingerprint);
        cache.delete(key); cache.set(key,{ hash: fingerprint,expires: Date.now()+60000 });
        while(cache.size>1000) cache.delete(cache.keys().next().value!);
      } catch { skipped=true; }
      finally { controller.abort(); try { if(reader) await reader.cancel(); else await response?.body?.cancel(); } catch { /* No body is retained. */ } }
    }
    return { hashes: [...hashes],skipped };
  };
}
