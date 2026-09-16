export type DataMode = "demo" | "trial" | "production";

// 环境 ID 不是密钥。由部署前检查填写；未配置时拒绝连接，不回退到演示身份。
export const runtime: { mode: DataMode; env: string; functionName: string } = {
  mode: "demo",
  env: "",
  functionName: "xueduTrial",
};
export const isCloud = () => runtime.mode !== "demo";
export const modeLabel = () => runtime.mode === "trial" ? "多人试用" : runtime.mode === "production" ? "正式版" : "本地体验";
