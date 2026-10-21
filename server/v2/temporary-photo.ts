import { MAX_PHOTO_BYTES } from "../../miniprogram/domain/photo-limits";
import { URL } from "node:url";
import { Buffer } from "node:buffer";

// Node 20 globals; keep their small used surface out of the mini-program typings.
interface AbortSignalLike { readonly aborted: boolean; }
declare class AbortController { readonly signal: AbortSignalLike; abort(): void; }
export type PhotoFetch = (url: string, options: {redirect:"error";credentials:"omit";signal:AbortSignalLike}) => Promise<{
  status: number; headers: {get(name:string):string|null};
  body: null | {getReader():{read():Promise<{done:true}|{done:false;value:Uint8Array}>;cancel():Promise<void>}};
}>;
declare const fetch: PhotoFetch;

/** Native wx.cloud.CDN filePath URL observed in the real SDK on 2026-10-21. */
export function temporaryPhotoUrl(value: string): string {
  if (value.length > 4096 || /[\s\\]/.test(value)) throw new Error("临时照片地址无效");
  const url = new URL(value);
  if (url.hostname !== "vweixinf.tc.qq.com" || !url.pathname.startsWith("/301/") ||
      !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || url.hash)
    throw new Error("临时照片地址无效");
  // Keep the SDK URL protocol. Its HTTP endpoint does not have a certificate for
  // this hostname; never bypass TLS verification or guess an alternate host.
  return url.href;
}

/** Bounded download; no redirects, ambient credentials, or URL/error logging. */
export async function readTemporaryPhoto(value: string, expectedBytes: number, timeoutMs: number, fetchFile: PhotoFetch = fetch): Promise<string> {
  const url = temporaryPhotoUrl(value);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_PHOTO_BYTES)
    throw new Error("照片大小无效");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, 1500)));
  try {
    const response = await fetchFile(url, {redirect:"error",credentials:"omit",signal:controller.signal});
    if (response.status !== 200 || !response.body) throw new Error("临时照片无法读取");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expectedBytes)) throw new Error("照片文件不完整");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > expectedBytes || bytes > MAX_PHOTO_BYTES) throw new Error("照片文件过大");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    if (bytes !== expectedBytes) throw new Error("照片文件不完整");
    const image = Buffer.concat(chunks);
    const jpeg = image.length >= 4 && image[0] === 255 && image[1] === 216 && image[2] === 255;
    const png = image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if (!jpeg && !png) throw new Error("请选择JPEG或PNG照片");
    return image.toString("base64");
  } finally { clearTimeout(timer); controller.abort(); }
}
