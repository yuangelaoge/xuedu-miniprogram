import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(
  "/Users/david/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json",
);
const sharp = require("sharp");
const icons = {
  home: '<path d="m4 11 8-7 8 7v9h-6v-6h-4v6H4z"/>',
  book: '<path d="M12 6v14M12 6C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 2z"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v5m10-5v5M3 11h18m-14 4h3m4 0h3m-10 3h3"/>',
  chart:
    '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 16v-4m4 4V8m4 8v-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
};
await fs.mkdir(new URL("../miniprogram/assets/", import.meta.url), {
  recursive: true,
});
for (const [name, body] of Object.entries(icons))
  for (const active of [false, true]) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 24 24"><g fill="none" stroke="' +
      (active ? "#2468e8" : "#8c96a8") +
      '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      body +
      "</g></svg>";
    await sharp(Buffer.from(svg))
      .png()
      .toFile(
        fileURLToPath(
          new URL(
            "../miniprogram/assets/" +
              name +
              (active ? "-active" : "") +
              ".png",
            import.meta.url,
          ),
        ),
      );
  }
