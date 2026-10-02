import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = join(ROOT, "dist", "cli.js");
export const FIXTURE = join(ROOT, "test", "fixtures", "talking.mp4");
