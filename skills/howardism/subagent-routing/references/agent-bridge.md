# Agent Bridge caller reference

Use this reference when the request or an existing operator policy authorizes
cross-harness work through an installed Agent Bridge. Prefer the native route in the caller's current harness
when it can satisfy the assignment.

## Discover the surface first

Inspect the bridge's advertised MCP tools and their live input schemas before
calling them. Do not infer a deployment, configured worker, model, profile, or
policy from this skill.

`AgentUsage`, when advertised, is read-only. It reports configured account
capacity observations and retained task consumption. Context-window usage is a
different measurement. A missing capacity value means unknown, not zero; a cached
observation can be stale. Use that evidence to inform a manual choice, then call
the ordinary `Agent` tool for the configured worker when manual dispatch is the
authorized path.

The routed-task surface requires all of `RouteTask`, `TaskOutput`, and `StopTask`.
It is daemon-owned and appears only after the operator enables routing and the
front half authenticates to the daemon. `RouteTask` admits a complete assignment
and a caller-local idempotency key under a named policy. `TaskOutput` and
`StopTask` use the returned stable task id. Consult the live schema for the
assignment structure instead of copying a frozen JSON example into a prompt.

If those tools are absent, do not treat the bridge as a router. Continue with the
authorized native or manual session path, or report that the requested route is
unavailable.

## Preserve the assignment boundary

The bridge authenticates the caller through operator configuration. Credentials,
principal identity, routing enablement, automatic selection, and configured worker
profiles are deployment choices. A caller must not supply a credential, select a
different principal, or use model text to expand its authority.

Before admission, make the assignment complete and immutable. Include the work
goal, allowed worker targets and profiles, model and effort pairs, approval
ceiling, task class, budget, acceptance checks, publication authority, canonical
workspace, exact base commit, allowed paths, and any declared dirty-input transfer. A change to any of those constraints
requires a new authorized assignment rather than a retry.

Use `pinned` for a single permitted candidate. It is the only route for modifying
work and admits at most one attempt. `balanced` is an operator-enabled automatic
policy for read-only work; it may inspect ordered eligible candidates and admit at
most two attempts. Neither policy may bypass the manifest's target, profile,
model, effort, approval, budget, workspace, or publication limits.

Keep same-engine work on the native path. A routed task can refuse a same-engine
candidate, and that refusal does not authorize another CLI or a weaker assignment.

## Follow the durable task

Save the task id, then use `TaskOutput` as the authoritative public task snapshot.
It carries the assignment-derived public task state and attempt record without
caller credentials or principal data. Record the selected worker, effective model
and effort, output or error, changed paths, acceptance evidence, and task status.
Read `AgentUsage` separately for usage provenance because task output does not
make account capacity or consumption complete.

Use `StopTask` when cancellation is authorized. It prevents a later attempt before
requesting cancellation. A lost response, uncertain dispatch, or incomplete stop
is `needs_reconciliation`: preserve the task's budget and workspace ownership,
inspect durable output, and reconcile observed effects before any next action.
Never replay an unknown model call.

For modifying work, use an isolated worktree at the declared base commit or the
bridge's explicit exclusive workspace claim. The claim coordinates bridge users,
not outside writers. A single integrator reviews and accepts the changed paths;
worker execution permission never authorizes a commit, push, pull request, or
merge.

## Evidence boundary

Check the deployed bridge's qualification evidence for the exact caller, worker,
adapter, and versions in use. Offline protocol tests do not establish live account
access, permission behavior, cancellation, or usage completeness. Report the
routes actually exercised; an adapter prototype is not a qualified worker.
