export function normalizeWords(text: string): string {
  return text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').toLowerCase().replace(/\s+/gu,' ').trim();
}
export function parseBlockedWords(text: string): string[] {
  const words = [...new Set(text.split(/[,\r\n]+/).map(normalizeWords).filter(Boolean))];
  if (words.length > 100 || words.some((word) => word.length > 100 || /[\p{Cc}\p{Cf}]/u.test(word))) throw new Error('INVALID_WORDS');
  return words;
}
export function matchBlockedWords(text: string,words: readonly string[]): string[] {
  const normalized = normalizeWords(text);
  return words.filter((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`,'iu').test(normalized);
  });
}
