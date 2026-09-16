import { context, run } from "../../services/store";
import { METRIC_FIELDS, Observation, UiEvent } from "../../domain/types";
import { ratio, percent } from "../../domain/metrics";
import { memberPage } from "../../services/member-page";
memberPage({
  data: {
    record: null as Observation | null,
    fields: [] as { label: string; value: string }[],
    attendance: "",
    canView: false,
  },
  onLoad(query: Record<string, string>) {
    run(() => {
      const { state, user } = context();
      const record = state.records.find((r) => r.id === query.id);
      if (!record) throw new Error("记录不存在");
      if (user.role === "member" && record.memberId !== user.id)
        throw new Error("体验版暂仅允许查看自己的明细与照片");
      this.setData({
        record,
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
    });
  },
  preview(e: UiEvent) {
    if (this.data.record)
      wx.previewImage({
        urls: this.data.record.photos,
        current: e.currentTarget.dataset.path,
      });
  },
});
