export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_PHOTO_BASE64_LENGTH = Math.ceil(MAX_PHOTO_BYTES / 3) * 4;
export const MAX_RECORD_PHOTOS = 1;
// Compression target stays below the existing private bucket's 525000-byte limit.
// File bytes travel via wx.cloud.CDN; this is not a cloud-function JSON budget.
export const PHOTO_TRANSPORT_BYTES = 384 * 1024;
export const PHOTO_REQUEST_BYTES = 16 * 1024;
export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i+1) >= 0xdc00 && text.charCodeAt(i+1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
export function photoBytes(base64: string): number {
  return base64.length * 3 / 4 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}
