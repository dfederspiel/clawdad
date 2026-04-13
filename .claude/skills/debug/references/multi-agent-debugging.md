# Multi-Agent Debugging

Multi-agent groups have a coordinator + specialists pattern. Debugging requires tracing the delegation chain.

## Trace a delegation chain

```bash
# Show all delegation events for a group
grep -E "delegation|Delegation|delegat" logs/clawdad.log | grep "Test Team"

# Show the full orchestration flow: delegations, completions, re-triggers
grep -E "delegation|All delegations complete|Processing messages|Spawning container" logs/clawdad.log | tail -30
```

## Key log patterns

| Pattern | Meaning |
|---------|---------|
| `Processing agent delegation` | Coordinator called delegate_to_agent |
| `Spawning container agent` (with agent name) | Specialist container starting |
| `Delegation complete` | Specialist finished and exited |
| `All delegations complete, re-triggering coordinator` | All specialists done, coordinator will re-spawn |
| `Processing messages ... agents: ["coordinator"]` | Coordinator re-triggered to synthesize |

## Common multi-agent issues

**Coordinator doesn't re-trigger after delegations:**
- Check that `"All delegations complete"` appears in logs
- If it does but no `"Processing messages"` follows: the message loop may have advanced the cursor. Multi-agent groups should NEVER use the piping path — check `isMultiAgent` guard in `startMessageLoop`.
- Verify the cursor: `sqlite3 store/messages.db "SELECT value FROM router_state WHERE key='last_agent_timestamp'"`

**Wrong agent name on messages ("Andy" instead of agent name):**
- `setActiveAgentName` must be called before each `sendMessage` (not just once per run)
- Parallel containers clobber the shared `activeAgentNames` map — each callback must re-assert

**Specialist container doesn't exit promptly:**
- Delegation containers should exit immediately (no idle loop). Check that `containerInput.isDelegation` is `true` in the agent-runner.
- Container rebuild may be needed: `CONTAINER_RUNTIME=docker ./container/build.sh`

**Delegation never starts (coordinator finishes without delegating):**
- Check coordinator's CLAUDE.md includes delegation instructions
- Verify `buildMultiAgentContext` is injecting the `delegate_to_agent` tool hint
- Check `NANOCLAW_CAN_DELEGATE` is `1` for the coordinator container

## Per-agent container logs

Agent containers are named with the agent: `nanoclaw-{group}-{agent}-{timestamp}`.

```bash
# List active containers for a group
docker ps --filter "name=nanoclaw-web-test-team" --format "{{.Names}} {{.Status}}"

# Check a specific agent's last run
ls -t groups/web_test-team/logs/container-*.log | head -3
```

## Check agent discovery

```bash
# Verify agents are discovered on startup
grep "Discovered agents" logs/clawdad.log | tail -5

# Check agent folder structure
ls -la groups/web_test-team/agents/*/
cat groups/web_test-team/agents/*/agent.json
```
