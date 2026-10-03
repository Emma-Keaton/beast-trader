/**
 * Writes `public/logos/manifest.json`: the list of coin logos that actually
 * exist in the repo.
 *
 * Without it the app has to guess whether a file is present, and a wrong
 * guess costs an HTTP 404 per coin on every page load. A manifest makes the
 * lookup exact and costs one tiny file, fetched once per session.
 *
 * Run automatically before the build; safe to run by hand.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "../public/logos");
const IMAGE = /\.(svg|png|webp|jpg|jpeg)$/i;

const files = [];

function walk(current, prefix = "") {
  if (!fs.existsSync(current)) return;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
    else if (IMAGE.test(entry.name)) files.push(`logos/${rel}`);
  }
}

walk(dir);
files.sort();

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ files }, null, 2));
console.log(`[logos] manifest: ${files.length} file(s)`);
