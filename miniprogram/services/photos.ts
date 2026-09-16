import { cloudCall, currentSnapshot } from "./cloud";

export async function uploadRecordPhotos(paths: string[], taskId: string): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) {
    let photo = path;
    let data = String(wx.getFileSystemManager().readFileSync(photo, "base64"));
    if (data.length > 680000) {
      photo = await new Promise<string>((resolve, reject) => wx.compressImage({ src: path, quality: 65, success: r => resolve(r.tempFilePath), fail: reject }));
      data = String(wx.getFileSystemManager().readFileSync(photo, "base64"));
    }
    if (data.length > 680000) throw new Error("照片较大，请裁剪表格后重新选择（每张约 500KB 内），并确保签字清晰");
    const uploaded = await cloudCall<{ fileID: string }>("photo", { base64: data, taskId, epoch: currentSnapshot().epoch });
    result.push(uploaded.fileID);
  }
  return result;
}
export async function recordPhotoUrls(recordId: string): Promise<string[]> {
  const result = await cloudCall<{ urls: string[] }>("photoUrls", { recordId, epoch: currentSnapshot().epoch });
  return result.urls;
}
