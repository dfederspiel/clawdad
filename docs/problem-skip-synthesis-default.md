# Problem: Coordinator synthesis turns are wasteful by default

## Background

When a coordinator delegates to a specialist via `delegate_to_agent`, the default behavior was to re-trigger the coordinator after the specialist responds. This "synthesis turn" lets the coordinator review the specialist's output and add commentary.

This is really a **delegation completion policy** — it determines who owns the final word in a delegation chain. The original boolean (`skip_synthesis`) was encoding this policy as a minor tool option, but it's architecturally a first-class concept: does the coordinator get a follow-up turn, or is the specialist's response final?

In practice, the synthesis turn almost never adds value for single-agent delegations. The specialist's response IS the final answer. The coordinator just echoes it ("Greeter says hi back. Anything else?") or adds filler ("Standing by.").

## Cost and UX impact

Each synthesis turn is a full LLM invocation — cache read of the entire conversation, plus output tokens. On test-team (Sonnet), a single "Say hi to the greeter" interaction produced:

- 1 coordinator turn (delegation) — ~$0.44
- 1 greeter turn — ~$0.12
- 1 coordinator synthesis turn — ~$0.44
- 1 coordinator idle turn (triggered by no follow-up) — ~$0.44

**Total: ~$1.44, of which ~$0.88 (61%) was wasted synthesis/idle turns.**

Beyond cost, the extra turns create **visible chatter** in the thread — the coordinator adds low-value commentary ("Standing by", "Anything else?") and extra work-state noise (typing indicators, SSE events). This degrades the UX by making the agent feel chatty and slow when it should feel direct.

test-team is the most expensive group at $27.66/24h across 84 runs. A significant portion of that is coordinator synthesis turns that add no information.

## What we tried

### 1. `skip_synthesis` boolean parameter (historical — replaced by `completion_policy`)

Added an optional `skip_synthesis: boolean` parameter to the MCP tool. When `true`, the coordinator is not re-triggered after the specialist responds. The plumbing worked end-to-end through the full IPC chain. This approach was superseded by the `completion_policy` enum described below, which made the correct behavior the default and gave the concept a proper name.

### 2. Prompt coaching (failed)

Updated the coordinator's CLAUDE.md with explicit instructions to always set `skip_synthesis: true` for single-agent delegations. Three iterations of increasingly forceful language:

1. "Use `skip_synthesis: true` for direct specialist questions"
2. "Every call to `delegate_to_agent` MUST include the `skip_synthesis` parameter"
3. Full examples with code blocks showing the exact syntax

**Result: The coordinator never passed the flag.** Verified by checking IPC delegation logs — `skipSynthesis` was absent from every delegation request. The CLAUDE.md was confirmed mounted in the container. The LLM (Sonnet) reads the instructions but does not reliably use optional tool parameters that deviate from default behavior.

## Resolution: `completion_policy` enum with correct default

Replaced the boolean with a first-class `completion_policy` enum on `delegate_to_agent`:

- **`final_response`** (default) — the specialist's response is the final answer. The coordinator does NOT get a follow-up turn.
- **`retrigger_coordinator`** — the coordinator gets a follow-up turn to review and synthesize. Use for multi-agent fan-outs.

This fixes both problems at once:
1. The default is now the common case (no synthesis), so the LLM doesn't need to remember to opt in.
2. The concept is named as what it is — a completion policy — rather than a negative-logic boolean.

### Full plumbing chain

```
delegate_to_agent({ completion_policy: "final_response" })
  → IPC file: { completionPolicy: "final_response" }
    → ipc.ts: onDelegateToAgent({ completionPolicy })
      → index.ts: skipRetrigger = (completionPolicy !== 'retrigger_coordinator')
        → group-queue.ts: enqueueDelegation(skipRetrigger: true)
          → completedDelegationRetriggers: per-delegation tracking
            → needsRetrigger = completedDelegationRetriggers.some(r => r)
```

### Why per-delegation retrigger tracking matters

The queue doesn't just check a single flag — it tracks the completion policy of each delegation individually via `completedDelegationRetriggers` in `group-queue.ts`. This matters because a single delegation batch can mix policies: an automation rule might delegate with `final_response` while a coordinator's own delegation in the same batch uses `retrigger_coordinator`. The coordinator is only re-triggered if at least one delegation in the batch requested it. Without per-delegation tracking, a single `final_response` delegation could suppress the re-trigger that another delegation in the same batch actually needs.

### Future extension

If more completion modes are needed (e.g., `silent` for fire-and-forget delegations), the enum is the right extension point. No more booleans.
