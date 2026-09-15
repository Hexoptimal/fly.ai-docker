/**
 * Everything the world records for export and for the Data panel. Plain rows, CSV out; no DOM here, so the headless
 * tools can use it too.
 *
 *   world     one row per second: population, brood, groups, aggregation, brain drift, relationships, generations
 *   flies     one row per fly every FLY_EVERY_S: where, doing what, eating, firing, brain drift, group
 *   lineage   one row per fly ever: parents, generation, genes, and on death the cause, age, meals, offspring
 *   brood     one row per egg: parents, substrate, and what became of it (hatched, emerged, or died and why)
 *   events    every mating, egg, hatch, meal, spider strike, death and dropping, with the time
 * Relationships are built on export from world.social.
 */
export type Cell = string | number | boolean | null | undefined;
export type Row = Record<string, Cell>;

export const FLY_EVERY_S = 5;

export class Table {
  rows: Row[] = [];
  dropped = 0;
  readonly name: string;
  readonly cap: number;
  constructor(name: string, cap: number) {
    this.name = name;
    this.cap = cap;
  }

  push(row: Row): void {
    if (this.rows.length >= this.cap) {
      const cut = Math.ceil(this.cap * 0.1);           // drop the oldest tenth, not one row per push
      this.rows.splice(0, cut);
      this.dropped += cut;
    }
    this.rows.push(row);
  }
}

export class DataLog {
  readonly world = new Table("world", 20_000);
  readonly flies = new Table("flies", 150_000);
  readonly events = new Table("events", 50_000);
  readonly lineage = new Map<number, Row>();
  readonly brood = new Map<number, Row>();
}

function cell(v: Cell): string {
  if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return "";
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Row[]): string {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(","));
  return lines.join("\n") + "\n";
}

export const round = (x: number, dp = 3): number => (Number.isFinite(x) ? Math.round(x * 10 ** dp) / 10 ** dp : x);
