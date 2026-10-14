interface Result { data: unknown; error: unknown }
interface Bucket {
  list(path: string, options: { limit: number; withDelimiter: boolean }): PromiseLike<Result>;
  upload(path: string, bytes: Uint8Array, options: { contentType: string; upsert: boolean }): PromiseLike<Result>;
  remove(paths: string[]): PromiseLike<Result>;
  createSignedUrls(paths: string[], expires: number): PromiseLike<Result>;
}
const ID_PREFIX = "pg://xuedu-photos/";
const FILE = /^cloud\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\.(jpg|png)$/;
function key(id: string): string {
  const path = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
  if (!FILE.test(path)) throw new Error("照片路径不属于当前业务目录");
  return path;
}
export function createPhotos(bucket: Bucket, decode: (base64: string) => Uint8Array) {
  return {
    async upload(path: string, base64: string): Promise<string> {
      const safe = key(path), bytes = decode(base64);
      if (bytes.byteLength > 512000) throw new Error("照片过大，请压缩至500KB内");
      const result = await bucket.upload(safe, bytes, { contentType: safe.endsWith(".png") ? "image/png" : "image/jpeg", upsert: /^cloud\/[a-zA-Z0-9-]+\/stable-[a-f0-9]{64}\.jpg$/.test(path) });
      if (result.error) throw new Error("照片上传失败");
      return ID_PREFIX + safe;
    },
    async list(prefix: string, limit = 20): Promise<string[]> {
      if (!/^cloud\/[a-zA-Z0-9-]+\/$/.test(prefix)) throw new Error("清理必须限定固定旧轮次目录");
      const result = await bucket.list(prefix, { limit: Math.min(20, Math.max(1, limit)), withDelimiter: false });
      const data = result.data as { objects?: { name: string }[]; folders?: unknown[]; hasNext?: boolean } | null;
      if (result.error || !data || !Array.isArray(data.objects) || !Array.isArray(data.folders) || data.folders.length || typeof data.hasNext !== "boolean" || (!data.objects.length && data.hasNext)) throw new Error("照片目录核查失败，未完成清理");
      return data.objects.map(o => {
        if (!o.name.startsWith(prefix)) throw new Error("照片清单越过固定轮次，已停止清理");
        return ID_PREFIX + key(o.name);
      });
    },
    async delete(ids: string[]): Promise<void> {
      if (ids.length > 20) throw new Error("照片删除批次过大");
      const result = await bucket.remove(ids.map(key));
      if (result.error) throw new Error("照片删除失败，请继续同一维护任务");
    },
    async urls(ids: string[]): Promise<string[]> {
      if (!ids.length) return [];
      const paths = ids.map(key);
      const result = await bucket.createSignedUrls(paths, 300);
      if (result.error || !Array.isArray(result.data)) throw new Error("照片链接暂时无法读取");
      const items = result.data as { path: string; fullSignedURL?: string; error?: unknown }[];
      return paths.map(path => {
        const item = items.find(v => v.path === path);
        if (!item || item.error || !item.fullSignedURL?.startsWith("https://")) throw new Error("照片链接无效");
        return item.fullSignedURL;
      });
    },
  };
}
