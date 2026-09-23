export type DataMode = "demo" | "cloud";
// 名称中的 trial 为历史标识；沿用现有 AppID、环境及函数，不新建环境。
export const runtime: { mode: DataMode; env: string; functionName: string } = {
  mode: "cloud", env: "xuedu-trial-d2gs2dpnla9206eb3", functionName: "xueduTrial",
};
export const isCloud = () => runtime.mode === "cloud";
export const modeLabel = () => isCloud() ? "云端业务" : "本地开发演示";
