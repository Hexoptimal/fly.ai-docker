/**
 * Where the always-on world's records go. Two sinks with one interface:
 *   supabase  Flybook's database, world_* tables (flybook/supabase/migrations/20260916120000_world_sim.sql)
 *   files     JSON lines under a directory, for running locally without touching the database
 * Rows are sent as { run_id, ..., row } with the simulation's own row in `row` (jsonb).
 */
import { mkdirSync, appendFileSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export type TableName = "world_seconds" | "world_fly_samples" | "world_events" | "world_lineage" | "world_eggs" | "world_relationships";

/** A database row: plain columns plus the simulation's own row as jsonb. */
export type DbRow = Record<string, unknown>;

export interface Checkpoint { runId: string; t: number; data: string }

export interface Sink {
  readonly kind: string;
  latestCheckpoint(): Promise<Checkpoint | null>;
  createRun(seed: number, gitSha: string, config: DbRow): Promise<string>;
  insert(table: TableName, rows: DbRow[]): Promise<void>;
  upsert(table: TableName, rows: DbRow[], onConflict: string): Promise<void>;
  saveCheckpoint(runId: string, t: number, data: string, keep: number): Promise<void>;
}

export class SupabaseSink implements Sink {
  readonly kind = "supabase";
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(url: string, serviceKey: string) {
    this.url = url.replace(/\/$/, "") + "/rest/v1";
    this.headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  }

  private async req(method: string, path: string, body?: unknown, prefer?: string): Promise<unknown> {
    const res = await fetch(this.url + path, {
      method,
      headers: { ...this.headers, ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async latestCheckpoint(): Promise<Checkpoint | null> {
    const rows = await this.req("GET", "/world_checkpoints?select=run_id,t,data&order=created_at.desc&limit=1") as { run_id: string; t: number; data: string }[];
    return rows?.length ? { runId: rows[0].run_id, t: rows[0].t, data: rows[0].data } : null;
  }

  async createRun(seed: number, gitSha: string, config: DbRow): Promise<string> {
    const rows = await this.req("POST", "/world_runs", [{ seed, git_sha: gitSha, config }], "return=representation") as { id: string }[];
    return rows[0].id;
  }

  async insert(table: TableName, rows: DbRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) await this.req("POST", `/${table}`, rows.slice(i, i + 500), "return=minimal");
  }

  async upsert(table: TableName, rows: DbRow[], onConflict: string): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      await this.req("POST", `/${table}?on_conflict=${onConflict}`, rows.slice(i, i + 500), "resolution=merge-duplicates,return=minimal");
    }
  }

  async saveCheckpoint(runId: string, t: number, data: string, keep: number): Promise<void> {
    await this.req("POST", "/world_checkpoints", [{ run_id: runId, t, bytes: data.length, data }], "return=minimal");
    const old = await this.req("GET", `/world_checkpoints?select=id&run_id=eq.${runId}&order=created_at.desc&offset=${keep}`) as { id: number }[];
    if (old?.length) await this.req("DELETE", `/world_checkpoints?id=in.(${old.map((r) => r.id).join(",")})`);
  }
}

/** Local stand-in: each table is a .jsonl file (upserts append too; the last line for a key wins). */
export class FileSink implements Sink {
  readonly kind = "files";
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, "checkpoints"), { recursive: true });
  }

  async latestCheckpoint(): Promise<Checkpoint | null> {
    const files = readdirSync(join(this.dir, "checkpoints")).filter((f) => f.endsWith(".json")).sort();
    if (!files.length) return null;
    return JSON.parse(readFileSync(join(this.dir, "checkpoints", files[files.length - 1]), "utf8"));
  }

  async createRun(seed: number, gitSha: string, config: DbRow): Promise<string> {
    const id = `local-${Date.now()}`;
    appendFileSync(join(this.dir, "world_runs.jsonl"), JSON.stringify({ id, seed, git_sha: gitSha, config, started_at: new Date().toISOString() }) + "\n");
    return id;
  }

  async insert(table: TableName, rows: DbRow[]): Promise<void> {
    if (rows.length) appendFileSync(join(this.dir, `${table}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  async upsert(table: TableName, rows: DbRow[]): Promise<void> {
    await this.insert(table, rows);
  }

  async saveCheckpoint(runId: string, t: number, data: string, keep: number): Promise<void> {
    const dir = join(this.dir, "checkpoints");
    writeFileSync(join(dir, `${Date.now()}.json`), JSON.stringify({ runId, t, data }));
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) if (existsSync(join(dir, f))) unlinkSync(join(dir, f));
  }
}
