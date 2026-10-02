// Long-running work (analysis, export) reported to the editor as jobs.
import { EventEmitter } from "node:events";

export interface Job {
  id: string;
  kind: "analyze" | "export" | "preview" | "voice";
  label: string;
  status: "running" | "done" | "error";
  progress: number;
  detail?: string;
  result?: unknown;
  error?: string;
  startedAt: string;
}

class Jobs extends EventEmitter<{ job: [Job] }> {
  private jobs = new Map<string, Job>();
  private n = 0;

  list(): Job[] {
    return [...this.jobs.values()].slice(-20);
  }

  async run<T>(kind: Job["kind"], label: string, fn: (update: (progress: number, detail?: string) => void) => Promise<T>): Promise<T> {
    const job: Job = { id: `j${++this.n}`, kind, label, status: "running", progress: 0, startedAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    this.emit("job", { ...job });
    let last = 0;
    const update = (progress: number, detail?: string) => {
      job.progress = progress;
      if (detail !== undefined) job.detail = detail;
      const now = Date.now();
      if (now - last > 150) {
        last = now;
        this.emit("job", { ...job });
      }
    };
    try {
      const result = await fn(update);
      Object.assign(job, { status: "done", progress: 1, result });
      return result;
    } catch (err) {
      Object.assign(job, { status: "error", error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      this.emit("job", { ...job });
    }
  }
}

export const jobs = new Jobs();
