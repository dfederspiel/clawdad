---
name: review
description: Structured code review of uncommitted changes. Checks for correctness bugs, contract gaps, safety issues, and architectural concerns. Use before committing significant features, after "/review", or when the user asks for a review of their changes.
---

# Review

Run a structured critique of uncommitted changes before committing. Catches the class of bugs that are obvious in hindsight but easy to miss when you're deep in implementation.

## When to use

- Before committing a feature (especially multi-file changes)
- User says "review", "review my changes", "/review"
- After a significant implementation session, before shipping

## Review protocol

### 1. Gather the diff

```bash
git diff --cached --stat  # staged changes
git diff --stat           # unstaged changes
git diff HEAD             # everything vs last commit
```

If nothing is staged, review the full working tree diff. If changes span multiple concerns, note that — the user may want to split commits.

### 2. Read the changed files

Read each modified file in full (not just the diff) to understand the surrounding context. The diff shows what changed; the file shows whether it fits.

### 3. Run the checks

Work through these categories in order. For each, either report findings or say "Clear."

#### Correctness

- **State bugs**: Shared mutable state modified without synchronization? Counters, maps, or flags that can drift? (e.g., a counter incremented on enqueue but checked across all groups)
- **Contract gaps**: Does the code promise something (via types, comments, config schema) that it doesn't deliver? Fields declared but never used? Parameters accepted but ignored?
- **Edge cases**: What happens with empty arrays, null values, missing config, concurrent calls? Does the code handle the "zero items" and "one item" cases?
- **Error paths**: Are errors caught and handled? Or silently swallowed? Does the error path clean up state?

#### Safety

- **Scope leaks**: Are things scoped correctly? Per-group vs global? Per-request vs per-process? (e.g., cooldowns keyed by ruleId alone when they should be per-group)
- **Injection**: Any user input flowing into regex, SQL, shell commands, or file paths without sanitization?
- **Resource leaks**: Timers, listeners, or handles that aren't cleaned up? Containers that might not exit?
- **Infinite loops**: Can rule chains, retries, or recursive calls run unbounded?

#### Architecture

- **Abstraction fit**: Does new code reuse existing patterns, or reinvent them? Is there existing infrastructure that should have been used?
- **Coupling**: Does the change thread dependencies through layers that shouldn't know about each other?
- **Mixed batches**: When new behavior coexists with old behavior (e.g., automation + normal delegations), do they interact correctly? What happens when both fire in the same window?

#### Completeness

- **Tests**: Do tests cover the new behavior? Are edge cases tested (empty, boundary, error)?
- **Documentation**: If agents or users need to know about this, is it documented where they'll see it? (CLAUDE.md, global CLAUDE.md, skill files)
- **Cleanup**: Any dead code, unused imports, TODO comments, or debug logging left behind?

### 4. Report format

```
## Review: <short description of changes>

### Correctness
- **High**: <description> — <file:line> — <suggested fix>
- **Medium**: <description>

### Safety
- Clear

### Architecture
- **Low**: <observation>

### Completeness
- **Medium**: <missing test or doc>

### Summary
<1-2 sentence overall assessment. Is this ready to ship?>
```

Severity levels:
- **High**: Will cause bugs or surprising behavior in production. Must fix before shipping.
- **Medium**: Likely to cause confusion or make the next change harder. Should fix.
- **Low**: Style, naming, or minor improvement. Fix if easy, skip if not.

### 5. If issues found

For High issues, suggest a concrete fix (not just "this is wrong" but "change X to Y"). For Medium issues, describe the fix direction. For Low issues, just note them.

Don't suggest fixes that go beyond the scope of the current changes — flag them as follow-ups instead.
