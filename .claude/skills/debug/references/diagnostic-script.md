# Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking NanoClaw Container Setup ==="

echo -e "\n1. Authentication configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "OK" || echo "MISSING - add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env"

echo -e "\n2. Env file copied for container?"
[ -f data/env/env ] && echo "OK" || echo "MISSING - will be created on first run"

echo -e "\n3. Container runtime running?"
docker info &>/dev/null && echo "OK" || echo "NOT RUNNING - start Docker Desktop (macOS) or sudo systemctl start docker (Linux)"

echo -e "\n4. Container image exists?"
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "OK" 2>/dev/null || echo "MISSING - run ./container/build.sh"

echo -e "\n5. Session mount path correct?"
grep -q "/home/node/.claude" src/container-runner.ts 2>/dev/null && echo "OK" || echo "WRONG - should mount to /home/node/.claude/, not /root/.claude/"

echo -e "\n6. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n7. Recent container logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "No container logs yet"

echo -e "\n8. Session continuity working?"
SESSIONS=$(grep "Session initialized" logs/nanoclaw.log 2>/dev/null | tail -5 | awk '{print $NF}' | sort -u | wc -l)
[ "$SESSIONS" -le 2 ] && echo "OK (recent sessions reusing IDs)" || echo "CHECK - multiple different session IDs, may indicate resumption issues"
```
