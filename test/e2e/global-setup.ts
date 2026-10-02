// Builds one analyzed (transcribed) project with the CLI; each test copies it, so
// transcription runs once per suite instead of once per test.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, FIXTURE, ROOT } from "./paths";

export default function globalSetup() {
  if (!existsSync(CLI) || !existsSync(join(ROOT, "dist", "web", "index.html"))) {
    throw new Error("cutroom isn't built. Run `npm run build` before `npm run test:e2e`.");
  }
  if (!existsSync(FIXTURE)) {
    console.log("Generating test fixtures (npm run fixtures)…");
    execFileSync("bash", [join(ROOT, "scripts", "make-fixtures.sh")], { cwd: ROOT, stdio: "inherit" });
  }
  const base = mkdtempSync(join(tmpdir(), "cutroom-e2e-"));
  const template = join(base, "template");
  console.log("Creating and transcribing the template project…");
  execFileSync(process.execPath, [CLI, "init", template, FIXTURE, "--name", "e2e"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], timeout: 600_000 });
  if (!existsSync(join(template, ".cutroom", "cache", "m1", "transcript.json"))) {
    throw new Error("Template project has no transcript. Is a transcription backend installed? Run `node dist/cli.js doctor`.");
  }
  process.env.CUTROOM_E2E_TEMPLATE = template;
  return () => rmSync(base, { recursive: true, force: true });
}
