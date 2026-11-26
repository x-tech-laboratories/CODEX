// Draws every icon size from resources/icon.svg: the desktop icon, the web page's icons and the Thunderbird add-on's.

// ── Imports ──────────────────────────────────────────────────────────────────

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

import { Resvg } from "@resvg/resvg-js";

// ── Icons ────────────────────────────────────────────────────────────────────

const source = readFileSync("resources/icon.svg", "utf8");

function draw(size: number, file: string): void {
  writeFileSync(file, new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng());
}

draw(512, "resources/icon.png");
draw(192, "src/web/public/icon-192.png");
draw(512, "src/web/public/icon-512.png");
draw(64, "thunderbird/public/icon-64.png");
copyFileSync("resources/icon.svg", "src/web/public/icon.svg");
console.log("Drew the icons from resources/icon.svg");
