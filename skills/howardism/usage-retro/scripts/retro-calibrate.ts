#!/usr/bin/env bun
// retro-calibrate: join a retro's brief items with the workers' verdicts, append the labelled rows
// to a private store, and report how precise Jev's probability was, so the act threshold is chosen
// from labels instead of guessed.
//
//   bun retro-calibrate.ts <briefs-dir> [--store path] [--target 0.85] [--min-n 10] [--selfcheck]
//
// Items come from <dir>/items.jsonl (retro-scan --briefs) joined to verdicts-<bucket>[-n].md by brief
// file and index. A dir without items.jsonl (an older scan) is parsed from the brief item tags:
// `(jev)` and `(both)` are >= 0.8 with no exact value (recorded as 0.8), `(jev 0.63, verify)` and
// `(jev 0.93, audit)` carry the value, a bare `(regex)` is 0.
// The store defaults to ${XDG_STATE_HOME:-~/.local/state}/retro/labels.jsonl. It holds prompt text,
// so it never lives in a repo: this repo is public.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Bucket = "nudges" | "corrections" | "gaps" | "repeats";
type Item = { file: string; index: number; bucket: Bucket; skill?: string; ts: string; sid: string; project: string; text: string; regex: boolean; jev: number | null; jev_model: string | null; settled?: boolean };
export type Labelled = Item & { date: string; label: string; evidence: string; verdict: "yes" | "no" | null };

// Verdict label prefixes that count as yes or no, per bucket. A bucket without an entry is stored with
// its raw label and counted, not scored. Extend this table to score another bucket.
const SCORING: Partial<Record<Bucket, { yes: string[]; no: string[] }>> = {
  gaps: { yes: ["applies"], no: ["incidental", "marginal", "not-a-gap"] },
};
export function score(bucket: Bucket, label: string): "yes" | "no" | null {
  const t = SCORING[bucket];
  if (!t) return null;
  const l = label.toLowerCase();
  return t.yes.some((p) => l.startsWith(p)) ? "yes" : t.no.some((p) => l.startsWith(p)) ? "no" : null;
}

// --- join -------------------------------------------------------------------
const briefItems = (text: string) => text.split(/^Items \(\d+\):$/m)[1]?.split("\n").filter((l) => l.startsWith("- ")) ?? [];
const bucketOf = (file: string) => file.replace(/^brief-/, "").replace(/(-\d+)?\.md$/, "") as Bucket;

// Old-scan fallback: recover what the tags and the item line carry.
export function parseItem(line: string, file: string, index: number): Item {
  const skill = /^- \[([^\]]+)\]/.exec(line)?.[1];
  const tags = [...line.matchAll(/\((?:jev (\d\.\d+), (?:verify|audit)|jev|both|regex)\)/g)];
  const valued = tags.find((t) => t[1]);
  const jev = valued ? Number(valued[1]) : tags.some((t) => t[0] === "(jev)" || t[0] === "(both)") ? 0.8 : 0;
  const ts = /\d{4}-\d\d-\d\dT\d\d:\d\d/.exec(line)?.[0] ?? "";
  const sid = /\b[0-9a-f]{8}\b/.exec(line.replace(/^- (\[[^\]]+\] )?/, "").replace(/\((?:jev[^)]*|both|regex)\)/g, ""))?.[0] ?? "";
  return { file, index, bucket: bucketOf(file), ...(skill ? { skill } : {}), ts, sid, project: /\(([^()\s]+)\) ::/.exec(line)?.[1] ?? "", text: line.split(" :: ").slice(1).join(" :: ") || line, regex: tags.some((t) => t[0] === "(regex)" || t[0] === "(both)"), jev, jev_model: "unknown" };
}

// Fails loudly when a brief and its verdicts file disagree on the item count.
export function join_(files: { file: string; brief: string; verdicts: string | null }[], sidecar: Item[] | null, date: string): Labelled[] {
  const out: Labelled[] = [];
  for (const { file, brief, verdicts } of files) {
    const lines = briefItems(brief);
    if (verdicts === null) throw new Error(`${file}: no verdicts file`);
    const v = verdicts.split("\n").filter((l) => l.trim());
    if (v.length !== lines.length) throw new Error(`${file}: ${lines.length} items but ${v.length} verdict lines`);
    const side = sidecar?.filter((i) => i.file === file).sort((a, b) => a.index - b.index);
    if (side && side.length !== lines.length) throw new Error(`${file}: ${lines.length} items but ${side.length} items.jsonl rows`);
    lines.forEach((line, i) => {
      const item = side ? side[i] : parseItem(line, file, i);
      const [label, ...rest] = v[i].split(":");
      out.push({ ...item, date, label: label.trim(), evidence: rest.join(":").trim(), verdict: score(item.bucket, label.trim()) });
    });
  }
  return out;
}

// --- store ------------------------------------------------------------------
const keyOf = (r: { bucket: string; sid: string; ts: string; skill?: string }) => [r.bucket, r.sid, r.ts, r.skill ?? ""].join("|");
export function readStore(path: string): Labelled[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l: string) => { try { return [JSON.parse(l) as Labelled]; } catch { return []; } });
}
// New rows only: a row already in the store keeps its first label.
export const freshRows = (have: Labelled[], rows: Labelled[]) => {
  const seen = new Set(have.map(keyOf));
  return rows.filter((r) => !seen.has(keyOf(r)) && seen.add(keyOf(r)));
};

// --- report -----------------------------------------------------------------
const BANDS = [
  { name: ">= 0.8", has: (p: number) => p >= 0.8 },
  { name: "0.5 to 0.8", has: (p: number) => p >= 0.5 && p < 0.8 },
  { name: "< 0.5 or 0", has: (p: number) => p < 0.5 },
] as const;
const pct = (y: number, n: number) => (n ? `${y}/${n} = ${(y / n).toFixed(2)}` : "0/0");

export function summarize(store: Labelled[], target: number, minN: number): string {
  const out: string[] = [];
  for (const bucket of [...new Set(store.map((r) => r.bucket))]) {
    const rows = store.filter((r) => r.bucket === bucket);
    if (!SCORING[bucket]) {
      const labels = [...new Set(rows.map((r) => r.label))].map((l) => `${l} ${rows.filter((r) => r.label === l).length}`);
      out.push(`${bucket}: ${rows.length} labelled, not scored (${labels.join(", ")})`);
      continue;
    }
    for (const model of [...new Set(rows.map((r) => r.jev_model ?? "none"))]) {
      const mine = rows.filter((r) => (r.jev_model ?? "none") === model && r.verdict && r.jev !== null);
      out.push(`${bucket}, jev model ${model}: ${mine.length} scored rows (${rows.filter((r) => (r.jev_model ?? "none") === model).length - mine.length} unscored or without jev)`);
      for (const b of BANDS) {
        const band = mine.filter((r) => b.has(r.jev!));
        out.push(`  ${b.name}: ${pct(band.filter((r) => r.verdict === "yes").length, band.length)} precision (${band.length} items)`);
      }
      let hit = "";
      for (let t = 5; t <= 100 && !hit; t += 5) {
        const sel = mine.filter((r) => r.jev! > 0 && r.jev! >= t / 100 - 1e-9);
        const yes = sel.filter((r) => r.verdict === "yes").length;
        if (sel.length >= minN && yes / sel.length >= target) hit = `${(t / 100).toFixed(2)} (${pct(yes, sel.length)})`;
      }
      out.push(`  lowest threshold with precision >= ${target} over >= ${minN} items: ${hit || "not enough labels"}`);
    }
  }
  return out.join("\n");
}

// --- main -------------------------------------------------------------------
function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const defaultStore = () => join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "retro/labels.jsonl");

if (import.meta.main) {
  if (has("selfcheck")) {
    console.assert(score("gaps", "applies (x)") === "yes" && score("gaps", "Marginal") === "no" && score("gaps", "not-a-gap") === "no" && score("gaps", "unreadable") === null && score("nudges", "applies") === null, "score");
    const gapBrief = "# x\n\nItems (3):\n- [rebase-babysit] (both) 2026-09-01T05:10 66cf8bc9 (proj-a) :: babysit\n- [rebase-babysit] (regex) (jev 0.63, verify) 2026-09-02T02:26 443017d9 (proj-b) :: rebase it\n- [research] (regex) 2026-09-03T06:19 f131519d (proj-c) :: research this :: twice\n";
    const p = parseItem(briefItems(gapBrief)[1], "brief-gaps.md", 1);
    console.assert(p.jev === 0.63 && p.regex && p.sid === "443017d9" && p.ts === "2026-09-02T02:26" && p.skill === "rebase-babysit" && p.project === "proj-b" && p.text === "rebase it", `parseItem ${JSON.stringify(p)}`);
    console.assert(parseItem(briefItems(gapBrief)[0], "brief-gaps.md", 0).jev === 0.8 && parseItem(briefItems(gapBrief)[2], "brief-gaps.md", 2).jev === 0, "tag values");
    console.assert(parseItem(briefItems(gapBrief)[2], "brief-gaps.md", 2).text === "research this :: twice", "item text keeps inner separator");
    const verdicts = "applies: yes (a)\nincidental: no (b)\nnot-a-gap: no (c)\n";
    const rows = join_([{ file: "brief-gaps.md", brief: gapBrief, verdicts }], null, "2026-09-29");
    console.assert(rows.length === 3 && rows[0].verdict === "yes" && rows[1].verdict === "no" && rows[1].evidence === "no (b)", "join_");
    let threw = false;
    try { join_([{ file: "brief-gaps.md", brief: gapBrief, verdicts: "applies: x\n" }], null, "d"); } catch { threw = true; }
    console.assert(threw, "count mismatch throws");
    const side: Item[] = rows.map((r, i) => ({ ...r, index: i, jev: [0.95, 0.6, 0][i], jev_model: "jev-t" }));
    const joined = join_([{ file: "brief-gaps.md", brief: gapBrief, verdicts }], side, "2026-09-29");
    console.assert(joined[0].jev === 0.95 && joined[2].jev_model === "jev-t", "join_ with sidecar");
    console.assert(freshRows(rows, rows).length === 0 && freshRows([], [...rows, ...rows]).length === 3, "freshRows");
    // 12 rows at 0.9 (10 yes), 4 at 0.6 (1 yes), 4 at 0 (2 yes): target 0.85 met at 0.9 only.
    const mk = (jev: number, yes: boolean, i: number): Labelled => ({ ...rows[0], sid: `s${i}`, jev, jev_model: "jev-t", verdict: yes ? "yes" : "no", label: yes ? "applies" : "incidental" });
    const store = [...Array.from({ length: 12 }, (_, i) => mk(0.9, i < 10, i)), ...Array.from({ length: 4 }, (_, i) => mk(0.6, i < 1, 20 + i)), ...Array.from({ length: 4 }, (_, i) => mk(0, i < 2, 30 + i))];
    const sum = summarize(store, 0.85, 10);
    console.assert(sum.includes(">= 0.8: 10/12 = 0.83") && sum.includes("0.5 to 0.8: 1/4") && sum.includes("< 0.5 or 0: 2/4") && sum.includes(": not enough labels"), `summarize ${sum}`);
    console.assert(summarize(store, 0.8, 10).includes(": 0.65 (10/12 = 0.83)") && summarize(store.slice(0, 6), 0.5, 10).includes("not enough labels"), "threshold");
    console.log("selfcheck ok");
  } else {
    const dir = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
    if (!dir) { console.error("usage: bun retro-calibrate.ts <briefs-dir> [--store path] [--target 0.85] [--min-n 10]"); process.exit(1); }
    const store = arg("store", defaultStore());
    const sidePath = join(dir, "items.jsonl");
    const sidecar = existsSync(sidePath) ? (readFileSync(sidePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) as Item[]) : null;
    const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);
    const files = readdirSync(dir).filter((f) => /^brief-.*\.md$/.test(f)).sort().map((file) => ({ file, brief: read(file)!, verdicts: read(file.replace(/^brief-/, "verdicts-")) }));
    const rows = join_(files, sidecar, new Date().toISOString().slice(0, 10));
    const have = readStore(store);
    const fresh = freshRows(have, rows);
    if (fresh.length) {
      mkdirSync(dirname(store), { recursive: true });
      appendFileSync(store, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    console.log(`joined ${rows.length} items from ${files.length} briefs (${sidecar ? "items.jsonl" : "brief tags"}); ${fresh.length} new, ${rows.length - fresh.length} already in ${store}`);
    console.log(summarize([...have, ...fresh], Number(arg("target", "0.85")), Number(arg("min-n", "10"))));
  }
}
