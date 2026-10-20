import { MAX_PHOTO_BYTES, photoBytes } from "../domain/photo-limits";
import { cloudCall, currentSnapshot } from "./cloud";

export async function uploadRecordPhotos(paths: string[], taskId: string): Promise<string[]> {
  if (paths.length !== 1) throw new Error("请上传1张签字照片");
  const result: string[] = [];
  for (const path of paths) {
    let photo = path;
    let data = String(wx.getFileSystemManager().readFileSync(photo, "base64"));
    if (photoBytes(data) > MAX_PHOTO_BYTES) {
      photo = await new Promise<string>((resolve, reject) => wx.compressImage({ src: path, quality: 65, success: r => resolve(r.tempFilePath), fail: reject }));
      data = String(wx.getFileSystemManager().readFileSync(photo, "base64"));
    }
    if (photoBytes(data) > MAX_PHOTO_BYTES) throw new Error("照片较大，请裁剪表格后重新选择（每张 2MB 内），并确保签字清晰");
    const uploaded = await cloudCall<{ fileID: string }>("photo", { base64: data, taskId, epoch: currentSnapshot().epoch });
    result.push(uploaded.fileID);
  }
  return result;
}
export async function recordPhotoUrls(recordId: string): Promise<string[]> {
  const result = await cloudCall<{ urls: string[] }>("photoUrls", { recordId, epoch: currentSnapshot().epoch });
  return result.urls;
}
