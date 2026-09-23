import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export async function buildCloud(outputDirectory = join(root, "cloudfunctions/xueduTrial/generated")) {
  const names = ["gateway", "postgres", "photos"];
  const forbidden = ["server/gateway.ts", "server/postgres.ts", "server/policy.ts", "miniprogram/domain/seed.ts"];
  const results = await Promise.all(names.map(name => build({
    absWorkingDir: root, entryPoints: [`server/v2/${name}.ts`], bundle: true,
    platform: "node", target: "node20", format: "cjs", write: false, metafile: true,
    outfile: join(outputDirectory, "v2", name + ".js"),
  })));
  const inputs = [...new Set(results.flatMap(result => Object.keys(result.metafile.inputs)))].sort();
  if (inputs.some(input => forbidden.includes(input))) throw new Error("Legacy cloud implementation must not enter V2 artifacts");
  // Only replace this known generated directory after every bundle passes validation.
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(join(outputDirectory, "v2"), { recursive: true });
  for (const result of results) for (const output of result.outputFiles) await writeFile(output.path, output.contents);
  const manifest = { protocolVersion: 2, functionName: "xueduTrial", runtimeTarget: "node20", inputs,
    artifacts: names.map(name => `v2/${name}.js`) };
  await writeFile(join(outputDirectory, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildCloud().then(() => console.log("Built protocol 2 for xueduTrial only. No deployment performed."))
    .catch(() => { console.error("Cloud build failed; no deployment performed."); process.exitCode = 1; });
}
