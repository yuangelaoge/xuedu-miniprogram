import { isCloud as cloudEnabled } from "../../config/runtime";
import { registerCloudPage } from "../../services/v2/page";
import { context, run } from "../../services/store";
import { METRIC_FIELDS, Observation, UiEvent } from "../../domain/types";
import { ratio, percent } from "../../domain/metrics";
import { memberPage } from "../../services/member-page";
import { isCloud } from "../../config/runtime";
import { recordPhotoUrls } from "../../services/photos";
import { notifyError } from "../../services/store";
if (cloudEnabled()) registerCloudPage("record"); else memberPage({
  data: {
    record: null as Observation | null,
    fields: [] as { label: string; value: string }[],
    attendance: "",
    canView: false,
    photos: [] as string[],
  },
  onLoad(query: Record<string, string>) {
    run(() => {
      const { state, user } = context();
      const record = state.records.find((r) => r.id === query.id);
      if (!record) throw new Error("记录不存在");
      if (!["admin", "leader"].includes(user.role) && record.memberId !== user.id)
        throw new Error("体验版暂仅允许查看自己的明细与照片");
      this.setData({
        record,
        photos: isCloud() ? [] : record.photos,
        canView: true,
        fields: METRIC_FIELDS.map((f) => ({
          label: f.label,
          value:
            record.metrics[f.key] < 0
              ? "信息缺失"
              : String(record.metrics[f.key]),
        })),
        attendance: percent(
          ratio(record.metrics.actual, record.metrics.expected),
        ),
      });
      if (isCloud()) void recordPhotoUrls(record.id).then(photos => this.setData({ photos })).catch(notifyError);
    });
  },
  async preview(e: UiEvent) {
    if (isCloud() && this.data.record) {
      try { const photos = await recordPhotoUrls(this.data.record.id); this.setData({ photos }); wx.previewImage({ urls: photos }); }
      catch (e) { notifyError(e); }
      return;
    }
    if (this.data.record)
      wx.previewImage({
        urls: this.data.record.photos,
        current: e.currentTarget.dataset.path,
      });
  },
});
