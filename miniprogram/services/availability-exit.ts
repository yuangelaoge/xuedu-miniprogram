/** Native back/gesture protection; page-owned navigation asks separately. */
export function syncAvailabilityExitAlert(dirty: boolean): void {
  if (dirty) {
    if (typeof wx.enableAlertBeforeUnload === "function")
      wx.enableAlertBeforeUnload({ message: "无课时间还未保存，确定离开吗？" });
  } else if (typeof wx.disableAlertBeforeUnload === "function") {
    wx.disableAlertBeforeUnload();
  }
}
