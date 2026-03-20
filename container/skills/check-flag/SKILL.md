---
name: check-flag
description: Check LaunchDarkly feature flag state for Polaris environments. Use when investigating E2E failures, verifying flag rollouts, or answering "is flag X on in env Y?" questions.
---

# /check-flag — LaunchDarkly Flag Lookup

Check the state of a feature flag across environments. Deterministic — always run the script, never guess from memory.

## Usage

`/check-flag <flag-key>` — full flag report (both environments, all rules)
`/check-flag <flag-key> <env>` — check if flag is active for a specific Polaris environment (e.g., `im`, `co`, `stg`)

## Step 1: Get the flag

```bash
FLAG_KEY="$1"
curl -sf -H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415" \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen/${FLAG_KEY}" > /tmp/flag.json

if [ $? -ne 0 ]; then
  echo "ERROR: Flag '${FLAG_KEY}' not found in polaris-nextgen"
  exit 1
fi
```

## Step 2: Parse and report

```bash
python3 << 'PYEOF'
import json, sys

with open('/tmp/flag.json') as f:
    data = json.load(f)

flag_key = data['key']
flag_name = data.get('name', flag_key)
kind = data.get('kind', 'boolean')
variations = data.get('variations', [])

# Optional: filter to specific Polaris env
target_env = sys.argv[1] if len(sys.argv) > 1 else None

print(f"**{flag_name}** (`{flag_key}`) — {kind}")
print()

for env_key in ['test', 'production']:
    env = data.get('environments', {}).get(env_key, {})
    on = env.get('on', False)
    off_var_idx = env.get('offVariation', 1)
    off_val = variations[off_var_idx]['value'] if off_var_idx is not None and off_var_idx < len(variations) else 'N/A'

    print(f"**{env_key}**: {'ON' if on else 'OFF'}")

    if not on:
        print(f"  Serving: `{off_val}` (off variation) to all contexts")
        print()
        continue

    rules = env.get('rules', [])
    env_values_in_rules = set()

    for i, rule in enumerate(rules):
        var_idx = rule.get('variation')
        rollout = rule.get('rollout')
        if var_idx is not None:
            var_val = variations[var_idx]['value']
        elif rollout:
            var_val = 'percentage rollout'
        else:
            var_val = '?'

        for clause in rule.get('clauses', []):
            attr = clause.get('attribute', '')
            op = clause.get('op', 'in')
            vals = clause.get('values', [])
            negate = clause.get('negate', False)
            neg_str = 'NOT ' if negate else ''
            print(f"  Rule {i}: `{attr}` {neg_str}`{op}` {vals} → `{var_val}`")
            if attr == 'env':
                env_values_in_rules.update(vals)

    ft = env.get('fallthrough', {})
    ft_var = ft.get('variation')
    ft_rollout = ft.get('rollout')
    if ft_var is not None:
        print(f"  Fallthrough: `{variations[ft_var]['value']}`")
    elif ft_rollout:
        weights = ft_rollout.get('variations', [])
        parts = [f"{variations[w['variation']]['value']}={w['weight']/1000}%" for w in weights if w.get('weight', 0) > 0]
        print(f"  Fallthrough: rollout [{', '.join(parts)}]")
    print()

    # If user asked about a specific Polaris env, check targeting
    if target_env and env_key == 'test':
        short = target_env.split('.')[0]  # normalize "im.dev.polaris.blackduck.com" to "im"
        matched = any(short == v or short == v.split('.')[0] for v in env_values_in_rules)
        if env_values_in_rules:
            if matched:
                print(f"  ✅ `{target_env}` IS targeted by a rule in test")
            else:
                print(f"  ⚠️ `{target_env}` is NOT in any rule — will get fallthrough value")
        else:
            print(f"  ℹ️ No env-based rules — all contexts get fallthrough")
        print()

PYEOF
```

Run the python script with the optional env argument:
```bash
python3 /tmp/check_flag.py "$2" 2>/dev/null
```

## Step 3: Report to channel

Post the output directly. If the flag was not found, search for similar flags:

```bash
curl -sf -H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415" \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen?filter=query%20equals%20%22${FLAG_KEY}%22&limit=5" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', [])
if items:
    print('Did you mean:')
    for f in items:
        print(f\"  - \`{f['key']}\` ({f.get('name', '')})\" )
else:
    print('No similar flags found.')
"
```

## Notes

- The `test` LD environment covers ALL non-production Polaris envs (im, co, stg, cdev, etc.)
- A flag being ON in `test` does NOT mean it's active everywhere — check the rule clauses for `env` attribute targeting
- Production requires `requireComments: true` for changes
- Always run the script fresh — never report flag state from memory or prior conversations
