---
name: report-bug
description: Triage a problem in ClawDad and, only if it is a confirmed core platform bug, file a sanitized GitHub issue against dfederspiel/clawdad. Conservative by default — user-side groups, custom CLAUDE.md, agent prompts, .env config, and fork modifications are NOT reportable. Triggers on "report bug", "file bug", "report this", "this looks like a clawdad bug", or "/report-bug".
---

# /report-bug

Triage a failure in ClawDad and, **only if** it is a confirmed defect or feature gap in the core platform, open a sanitized GitHub issue at `dfederspiel/clawdad`.

## Be conservative

Default to "this is not a platform bug." Most failures are user-side and stay user-side. The bar for filing is **evidence that pristine ClawDad source is broken or missing a capability the platform claims to support**. When uncertain, do not file.

These are **never** platform bugs:
- Custom group `CLAUDE.md`, agent prompts, `agent.json`
- Anything in `groups/*/` other than the template groups
- The user's `.env`, credentials, or auth setup
- Local modifications to `src/`, `container/`, or `web/`
- Misconfiguration (wrong trigger, missing token, broken mount path)
- Environment problems (Docker not running, port conflicts, stale services)
- Agent behavior the user dislikes but which is working as designed

## Phase 1 — Symptoms

If the user has not already explained, gather (use `AskUserQuestion` if needed):
- What were they trying to do?
- What did they expect?
- What actually happened?
- Can they reproduce it?

Stay focused. One or two questions, not a survey.

## Phase 2 — Triage

Run these checks. Do not invent extras unless evidence demands it.

### A. Environment

```bash
docker info > /dev/null 2>&1 && echo "docker: OK" || echo "docker: DOWN"
pgrep -fc 'dist/index.js'        # >1 means a stale instance is running
curl -sf http://localhost:3456/health > /dev/null && echo "web: OK" || echo "web: DOWN"
```

If any fails → **environment issue**. Explain the fix and stop. Do not file.

### B. Failing component

```bash
tail -200 logs/clawdad.log 2>/dev/null | grep -iE "error|fail|exit|timeout" | tail -20
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3
```

Read the most recent container log if relevant. Identify where the failure originates:

| Origin | Verdict |
|---|---|
| `src/...`, `container/agent-runner/...`, `web/js/...` | Possibly platform |
| `groups/main/CLAUDE.md`, `groups/global*/CLAUDE.md` | Possibly platform (template files) |
| `groups/<other>/...` | User content — **not a bug** |
| Missing/bad env var | User config — **not a bug** |
| Custom skill, custom agent | User content — **not a bug** |

### C. Local fork status

```bash
git status --short
git log --oneline origin/main..HEAD 2>/dev/null
```

If the user has uncommitted changes or local commits that touch the failing area → **the bug may live in their fork, not ClawDad**. Tell them: "Local changes detected in `<area>`. Try reproducing on a clean checkout of `main` first." Stop unless they confirm reproduction on pristine source.

## Phase 3 — Verdict

State the verdict explicitly to the user. Pick exactly one:

| Verdict | Action |
|---|---|
| Environment | Explain fix. Stop. |
| User content/config | Point to `/debug` or relevant docs. Stop. |
| User fork modification | Ask to reproduce on pristine `main`. Stop. |
| Uncertain | Default to not reportable. Explain reasoning. Stop. |
| **Core platform bug** | Proceed to Phase 4. |
| **Core platform feature gap** | Proceed to Phase 4. File as enhancement. |

Do not advance to Phase 4 unless the verdict is one of the bottom two and the evidence is clear.

## Phase 4 — Collect & sanitize diagnostics

### Environment fingerprint

```bash
node --version
docker --version
uname -srm
jq -r .version package.json
git rev-parse --short HEAD
```

### Log excerpt

Pull ~50 lines around the failure from `logs/clawdad.log` and the relevant `container-*.log`. Do not dump entire log files.

### Sanitization — apply BEFORE showing the user

Strip aggressively. False positives are fine; leaks are not.

- **Secrets:** any value for env vars matching `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, `*_AUTH_*`
- **Emails:** replace with `<email>`
- **Phone numbers / WhatsApp JIDs:** replace with `<phone>` / `<jid>`
- **Group folder names:** replace `groups/<folder>/` with `groups/<group>/`
- **User home paths:** replace `$HOME` and `/home/<user>` with `<home>`
- **API keys / OAuth tokens** in URLs and log lines: replace the value with `<redacted>`

**Never include:**
- The contents of any `CLAUDE.md` (may contain proprietary instructions)
- The contents of `.env`
- Real chat transcripts
- Internal hostnames or URLs

After sanitizing, **show the diagnostic payload to the user verbatim** and ask them to confirm nothing sensitive remains.

## Phase 5 — Check for duplicates

```bash
gh issue list --repo dfederspiel/clawdad --state all \
  --search "<2-3 word fragment from the error>" --limit 10
```

If a likely match exists, show it to the user. Offer to add a comment to the existing issue instead of filing a new one.

## Phase 6 — File

Confirm the title and body with the user (`AskUserQuestion`) before posting.

Body template:

```markdown
## What I was doing
<sanitized reproduction steps from Phase 1>

## Expected
<from Phase 1>

## Actual
<from Phase 1>

## Environment
- ClawDad: <git short hash> (v<package.json version>)
- Node: <version>
- Docker: <version>
- OS: <uname -srm>

## Logs
\`\`\`
<sanitized log excerpt, ≤50 lines>
\`\`\`

## Triage
Verdict: <bug | feature gap> in <component>.
Verified on pristine `main`: <yes | no>.
```

File with:

```bash
gh issue create --repo dfederspiel/clawdad \
  --title "<short imperative title>" \
  --body-file /tmp/clawdad-bug-report.md \
  --label bug
```

(Write the body to a temp file rather than passing inline — easier to review and avoids shell escaping pitfalls.)

Show the resulting issue URL to the user.

## What this skill is NOT for

- Helping a user fix their agent's behavior — use `/debug`
- Filing user-side configuration issues
- Filing issues against forks of ClawDad
- Security disclosures — those should go through a private channel, not a public GitHub issue

If the user insists on filing something this skill considers non-reportable, explain why and decline. They are free to file manually on GitHub if they disagree.
