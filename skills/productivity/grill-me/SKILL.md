---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Use `AskUserQuestion` to interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer (marked).

Ask the questions one at a time.

Use `TaskCreate` to capture each open branch of the decision tree as a task, and `TaskUpdate` to mark a branch resolved as soon as the decision is made. Add new tasks as fresh branches surface during grilling.

If a question can be answered by exploring the codebase (`Read`, `Grep`, `Glob`), explore the codebase instead.
