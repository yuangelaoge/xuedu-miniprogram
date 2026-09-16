import { build } from "esbuild";
import { readFile } from "node:fs/promises";
await build({ entryPoints: ["server/gateway.ts"], bundle: true, platform: "node", target: "node18", format: "cjs", outfile: "cloudfunctions/xueduTrial/generated/gateway.js" });
const entry = await readFile("cloudfunctions/xueduTrial/index.js", "utf8");
await build({ stdin: { contents: entry.replace('const stage = "trial";', 'const stage = "production";').replace('const collection = "xuedu_trial_workspace";', 'const collection = "xuedu_production_workspace";'), resolveDir: "cloudfunctions/xueduTrial", sourcefile: "index.js" }, bundle: true, platform: "node", target: "node18", format: "cjs", external: ["wx-server-sdk"], outfile: "cloudfunctions/xueduProduction/index.js" });
console.log("Built separate trial and production functions. No deployment performed.");
