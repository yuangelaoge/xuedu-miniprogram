import { notifyError } from "./store";
export function saveExport(
  filename: string,
  data: string | ArrayBuffer,
  onSaved: (path: string) => void,
  onFinished: () => void = () => {},
): void {
  const path = wx.env.USER_DATA_PATH + "/" + filename;
  wx.getFileSystemManager().writeFile({
    filePath: path,
    data,
    encoding: "utf8",
    success: () => onSaved(path),
    fail: () => notifyError(new Error("文件保存失败，请检查设备存储空间")),
    complete: onFinished,
  });
}
export function openExport(path: string): void {
  if (path.endsWith(".xlsx"))
    wx.openDocument({
      filePath: path,
      fileType: "xlsx",
      showMenu: true,
      fail: () =>
        notifyError(
          new Error("当前环境无法预览 Excel；文件已保存，可在真机打开或分享。"),
        ),
    });
  else {
    // 老基础库没有文件分享能力时，保留复制文本的可用路径。
    const api = wx as unknown as {
      shareFileMessage?: (value: {
        filePath: string;
        fileName: string;
        fail: () => void;
      }) => void;
    };
    if (api.shareFileMessage)
      api.shareFileMessage({
        filePath: path,
        fileName: path.split("/").pop() || "名单.txt",
        fail: () =>
          wx.showToast({ title: "文件已保存，也可复制名单", icon: "none" }),
      });
    else wx.showToast({ title: "文件已保存，请使用复制名单", icon: "none" });
  }
}
