// Oracle and null checks for the delegation-plan grader, run with `bun test`.
// No model call: each test feeds a hand-built spawn list through gradeCase.
import { describe, expect, test } from "bun:test";
import { gradeCase, role, type Spawn } from "./run-eval.ts";

const CLONE = "/private/tmp/claude-501/delegation-plan-eval/x/repo";
const impl = (i: number, model = "sonnet", extra = ""): Spawn => ({
  tool: "Agent",
  input: { subagent_type: "general-purpose", model, description: `Implement package ${i}` },
  brief: `Role and mode: Claude Code worker, model ${model}, write-enabled implementer.\n` +
    `Workspace (exclusive): /private/tmp/wt-${i}, branch feat/p${i}.\n` +
    `Constraints: do not commit; leave changes uncommitted.${extra}`,
});
const parallel = { start: 3, packages: 4, opus_ok: 1, shape: "parallel", user_model: null };
const single = { start: 1, packages: 1, opus_ok: 0, shape: "single", user_model: null };
const run = (spawns: Spawn[], transcript: any[] = []) =>
  ({ model: "claude-opus-5-5", spawns, transcript, clone: CLONE });

describe("gradeCase", () => {
  test("oracle: expected count, sonnet, separate worktrees, commits withheld", async () => {
    const g = await gradeCase(parallel, run([impl(1), impl(2), impl(3)]));
    expect(g.grade).toEqual({ split_ok: 1, tier_ok: 1, coverage: 1, solo_ok: 1, commit_withheld: 1, disjoint_ok: 1 });
  });

  test("null: no spawns fails the split and leaves per-implementer checks empty", async () => {
    const g = await gradeCase(parallel, run([]));
    expect(g.grade.split_ok).toBe(0);
    expect(g.grade.coverage).toBe(0);
    expect(g.grade.commit_withheld).toBeNull();
    expect(g.grade.disjoint_ok).toBeNull();
  });

  test("one Opus worker for the whole plan fails split and coverage is partial", async () => {
    const g = await gradeCase(parallel, run([impl(1, "opus")]));
    expect(g.grade.split_ok).toBe(0);
    expect(g.grade.coverage).toBeCloseTo(1 / 3);
    expect(g.grade.tier_ok).toBe(1); // one Opus allowed: opus_ok = 1
  });

  test("an unset model inherits the root's Opus and counts against the tier", async () => {
    const noModel = impl(1);
    delete noModel.input.model;
    const g = await gradeCase(single, run([noModel]));
    expect(g.grade.tier_ok).toBe(0);
  });

  test("over-splitting a single package fails", async () => {
    const g = await gradeCase(single, run([impl(1), impl(2)]));
    expect(g.grade.split_ok).toBe(0);
  });

  test("a brief that allows commits fails commit_withheld", async () => {
    const committing = { ...impl(2), brief: impl(2).brief.replace("do not commit; leave changes uncommitted.", "create atomic commits as you go.") };
    const g = await gradeCase(parallel, run([impl(1), committing, impl(3)]));
    expect(g.grade.commit_withheld).toBe(0);
  });

  test("two workers in one workspace with no owned paths fail disjoint", async () => {
    const shared = (i: number): Spawn => ({ ...impl(i), brief: impl(i).brief.replace(`/private/tmp/wt-${i}`, "/private/tmp/wt-shared") });
    const g = await gradeCase(parallel, run([shared(1), shared(2), shared(3)]));
    expect(g.grade.disjoint_ok).toBe(0);
  });

  test("root editing a project file in the clone fails solo_ok", async () => {
    const edit = { role: "tool_call", name: "Edit", content: JSON.stringify({ file_path: `${CLONE}/src/lib.rs` }) };
    const g = await gradeCase(parallel, run([impl(1), impl(2), impl(3)], [edit]));
    expect(g.grade.solo_ok).toBe(0);
  });

  test("user-requested model overrides the open-decision rule", async () => {
    const g = await gradeCase({ ...single, user_model: "sonnet", opus_ok: 1 }, run([impl(1, "opus")]));
    expect(g.grade.tier_ok).toBe(0);
  });
});

describe("role", () => {
  test("reviewers, committers and Explore are not implementers", () => {
    expect(role({ tool: "Agent", input: { subagent_type: "Explore" }, brief: "" })).toBe("read");
    expect(role({ tool: "Agent", input: { description: "Opus review of Phase A" }, brief: "Role: read-only reviewer. Review the diff." })).toBe("read");
    expect(role({ tool: "Agent", input: { description: "Commit engine-sync Round 1" }, brief: "Role: committer, commit-only authority. Create atomic commits." })).toBe("commit");
    expect(role(impl(1))).toBe("impl");
    expect(role({ tool: "Agent", input: { description: "Commit TF bump in worktree" }, brief: "Role and mode: write-enabled for git index/commit ONLY." })).toBe("commit");
    expect(role({ tool: "Agent", input: { description: "Babysit PR 1300 to merge-ready" }, brief: "" })).toBe("other");
    expect(role({ tool: "Agent", input: { description: "Scout formal-math sources for cycle" }, brief: "write-enabled" })).toBe("read");
    expect(role({ tool: "Agent", input: { description: "Fix Phase B review findings" }, brief: "write-enabled implementer" })).toBe("impl");
    expect(role({ tool: "Agent", input: { description: "Pre-flight kill switch + verify-flat" }, brief: "" })).toBe("impl");
  });
});
