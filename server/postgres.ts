import { Document, freshDocument } from "./gateway";

export interface PgResult { data: unknown; error: unknown }
export interface PgRpc {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<PgResult>;
}
interface StoredDocument { revision: number; document: Document }

// Read/compute/CAS is optimistic concurrency control. All concurrent writers,
// including cleaning=true changes that do not bump business version, share the
// SQL revision. Callbacks must contain only in-memory business changes.
export function postgresTransaction(db: PgRpc, stage: "trial" | "production", uuid: () => string) {
  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await db.rpc(name, args);
    if (result.error) {
      // Only expose a machine-readable code, never SQL details, rows or tokens.
      const code = typeof result.error === "object" && result.error !== null ?
        (result.error as { code?: unknown }).code : undefined;
      const diagnostic = typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? "（" + code + "）" : "";
      const message = (result.error as { message?: unknown }).message;
      const denied = typeof message === "string" && /permission denied/i.test(message);
      const target = denied && /schema\s+public\b/i.test(message) ? "：public schema 权限不足" :
        denied && /schema\s+xuedu_private\b/i.test(message) ? "：业务 schema 权限不足" :
        denied && /function\s+xuedu_read_workspace\b/i.test(message) ? "：读取函数权限不足" :
        denied && /(?:table|relation)\s+workspace\b/i.test(message) ? "：业务表权限不足" : "";
      throw new Error("云端数据库操作失败" + diagnostic + target + "，请稍后刷新；若持续失败请联系管理员检查 PostgreSQL 配置");
    }
    return result.data;
  }
  return async function transact<T>(fn: (doc: Document) => Promise<T>): Promise<T> {
    const initial = freshDocument(stage, uuid());
    for (let attempt = 0; attempt < 6; attempt++) {
      const stored = await rpc("xuedu_read_workspace", { p_stage: stage, p_initial: initial }) as StoredDocument;
      if (!stored || !Number.isSafeInteger(stored.revision) || stored.revision < 0 ||
          !stored.document?.state || stored.document.stage !== stage)
        throw new Error("云端数据格式异常，已停止写入");
      const doc = JSON.parse(JSON.stringify(stored.document)) as Document;
      const before = JSON.stringify(doc);
      const result = await fn(doc);
      doc.state.actorId = "";
      if (before === JSON.stringify(doc)) return result;
      const committed = await rpc("xuedu_commit_workspace", {
        p_stage: stage, p_revision: stored.revision, p_document: doc,
      });
      if (committed === true) return result;
      if (committed !== false) throw new Error("云端提交结果异常，请刷新确认操作结果");
      // Retry only an explicit CAS conflict, never a network/unknown outcome.
    }
    throw new Error("同时操作较多，请刷新后重试");
  };
}

interface PhotoBucket {
  list?(path: string, options: { limit: number; withDelimiter: boolean }): PromiseLike<PgResult>;
  upload(path: string, data: Uint8Array, options: { contentType: string; upsert: boolean }): PromiseLike<PgResult>;
  remove(paths: string[]): PromiseLike<PgResult>;
  createSignedUrls(paths: string[], expiresIn: number): PromiseLike<PgResult>;
}

export function postgresPhotos(bucket: PhotoBucket, stage: "trial" | "production") {
  const prefix = "pg://xuedu-photos/";
  const pathPattern = new RegExp("^" + stage + "/[a-zA-Z0-9-]+/[a-zA-Z0-9-]+\\.(jpg|png)$");
  function validate(path: string): string {
    if (!pathPattern.test(path)) throw new Error("照片路径无效");
    return path;
  }
  function decode(id: string): string {
    if (!id.startsWith(prefix)) throw new Error("照片存储标识无效");
    return validate(id.slice(prefix.length));
  }
  return {
    async listResetFiles(): Promise<string[]> {
      if (!bucket.list) throw new Error("当前存储不支持完整清理核查");
      const result = await bucket.list(stage + "/", { limit: 20, withDelimiter: false });
      const data = result.data as { folders?: unknown[]; objects?: { name: string }[]; hasNext?: boolean } | null;
      if (result.error || !data || !Array.isArray(data.objects) || !Array.isArray(data.folders) || data.folders.length ||
        typeof data.hasNext !== "boolean" || (!data.objects.length && data.hasNext)) throw new Error("照片清单核查失败，未完成重置");
      return data.objects.map(o => prefix + validate(o.name));
    },
    async upload(path: string, data: Uint8Array): Promise<string> {
      validate(path);
      const result = await bucket.upload(path, data, { contentType: path.endsWith(".png") ? "image/png" : "image/jpeg", upsert: false });
      if (result.error) throw new Error("照片上传失败，请稍后重试");
      return prefix + path;
    },
    async deleteFiles(ids: string[]): Promise<void> {
      const paths = ids.map(decode);
      for (let i = 0; i < paths.length; i += 50) {
        const result = await bucket.remove(paths.slice(i, i + 50));
        if (result.error) throw new Error("部分照片删除失败，请重新预览范围并重试清理");
      }
    },
    async urls(ids: string[]): Promise<string[]> {
      if (!ids.length) return [];
      const paths = ids.map(decode);
      const result = await bucket.createSignedUrls(paths, 300);
      if (result.error || !Array.isArray(result.data)) throw new Error("照片暂时无法读取");
      const items = result.data as { path: string; fullSignedURL: string | null; error: unknown }[];
      return paths.map(path => {
        const item = items.find(value => value.path === path);
        if (!item || item.error || !item.fullSignedURL?.startsWith("https://")) throw new Error("照片暂时无法读取");
        return item.fullSignedURL;
      });
    },
  };
}
