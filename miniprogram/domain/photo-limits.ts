export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const MAX_PHOTO_BASE64_LENGTH = Math.ceil(MAX_PHOTO_BYTES / 3) * 4;
export const MAX_RECORD_PHOTOS = 1;
export function photoBytes(base64: string): number {
  return base64.length * 3 / 4 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}
