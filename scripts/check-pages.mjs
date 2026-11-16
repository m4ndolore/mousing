// Syntax-check the inline <script> blocks in src/pages/**/*.html, which no
// bundler or test touches. Each block goes through `node --check`, as an
// ES module when the tag says type="module".
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGES_DIR = "src/pages";
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;

const workDir = mkdtempSync(join(tmpdir(), "check-pages-"));
let failures = 0;
try {
  const pages = readdirSync(PAGES_DIR, { recursive: true }).filter((f) => f.endsWith(".html"));
  for (const file of pages) {
    const html = readFileSync(join(PAGES_DIR, file), "utf8");
    let index = 0;
    for (const [, attrs, code] of html.matchAll(INLINE_SCRIPT)) {
      const ext = /type=["']module["']/.test(attrs) ? "mjs" : "cjs";
      const scriptPath = join(workDir, `${file.replaceAll("/", "_")}.${index++}.${ext}`);
      writeFileSync(scriptPath, code);
      const result = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
      if (result.status !== 0) {
        failures++;
        console.error(`${file} (script ${index}):\n${result.stderr}`);
      }
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) process.exit(1);
console.log("Inline page scripts parse cleanly.");
