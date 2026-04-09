---
name: launchdarkly
description: Comprehensive LaunchDarkly feature flag management — search, inspect, compare, toggle, and audit flags across environments. Use for any LD flag question beyond simple lookups (which /check-flag handles).
---

# /launchdarkly — LaunchDarkly Feature Flag Management

Full-featured LaunchDarkly API skill for the `polaris-nextgen` project. Covers searching, inspecting, comparing, toggling, and auditing feature flags.

## Usage

```
/launchdarkly search <query>          — search flags by key/name substring
/launchdarkly get <flag-key>          — full flag detail with targeting rules
/launchdarkly get <flag-key> <env>    — check effective value for a Polaris env (im, co, cdev, etc.)
/launchdarkly compare <flag-key>      — side-by-side test vs production comparison
/launchdarkly toggle <flag-key> <ld-env> <on|off> — toggle flag (requires user approval)
/launchdarkly update-fallthrough <flag-key> <ld-env> <variation-index> — change fallthrough variation
/launchdarkly add-env-target <flag-key> <ld-env> <rule-index> <env-values...> — add Polaris env values to a rule
/launchdarkly audit <flag-key>        — show flag metadata, status, code refs, and change history
/launchdarkly list-stale              — find flags inactive for 30+ days
```

## Auth

Pass credentials explicitly via env vars. Do NOT use `source /workspace/scripts/auth-args.sh` or helper functions.

```bash
LD_AUTH=(-H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415")
```

All calls go through `api.sh`:
```bash
/workspace/scripts/api.sh launchdarkly <METHOD> <URL> "${LD_AUTH[@]}" [extra args...]
```

## API Reference

### Base URL
```
https://app.launchdarkly.com/api/v2
```

### Primary Project
- **Key**: `polaris-nextgen`
- **ID**: `614503ab68025d265b2432cc`
- **Flags**: 1,082+

### LD Environments

| LD Key | Display | Maps to Polaris |
|--------|---------|-----------------|
| `test` | Development | All non-prod (im, co, stg, cdev, tm, se, perf, scan, pim, ilmp, cov, clps, infr, mesh) |
| `production` | Production | prd, ksa, peu, poc |

### Targeting Model

Flags in `test` target specific Polaris environments via **custom context attributes** (contextKind: `user`). A flag being ON in `test` does NOT mean it serves `true` everywhere — you must check rule clauses.

The Polaris app sends **two custom attributes** when identifying with the LD SDK:

```typescript
ldClient.identify({
  anonymous: true,
  custom: { tenant: orgId, env: ldEnvironment }
})
```

#### `env` — hostname / Polaris environment

The primary discriminator. Derived from the browser's `window.location.hostname` (or explicit config). Values appear in two forms:
- **Short**: `im`, `co`, `stg`, `cdev`
- **FQDN**: `im.altair.synopsys.com`, `im.dev.polaris.blackduck.com`

Both forms may appear in the same rule. When checking if a flag is active for a specific Polaris environment, **match against both the short name and the full hostname** (e.g., `im` AND `im.dev.polaris.blackduck.com`).

#### `tenant` — organization / tenant ID

A secondary discriminator used when a flag needs to target specific tenants within an environment. The value is typically an organization UUID (e.g., `a1b2c3d4-e5f6-...`).

Rules may use `tenant` clauses to:
- Roll out a feature to specific tenants first (canary)
- Exclude certain tenants from a feature
- Enable a feature only for demo/internal tenants

#### Evaluation order

When a flag is ON, LD evaluates in this order:
1. **Individual targets** — specific user keys
2. **Rules** — clauses can match on `env`, `tenant`, or both in the same rule
3. **Fallthrough** — default when no rules match

**A flag can have rules that combine `env` AND `tenant` in the same rule** (e.g., "serve `true` when `env` is `im` AND `tenant` is `<specific-org-id>`"). Always report ALL clause attributes in a rule, not just `env`.

#### Checking effective flag state

When asked "is flag X active for environment Y?" — checking just the LD environment toggle (ON/OFF) is NOT sufficient. You must:
1. Check if the flag is ON in the LD environment (`test` or `production`)
2. Walk the rules and check if `env` clause values include the target environment/hostname
3. Check if any `tenant` clauses further restrict the rule (if so, report this)
4. If no rules match, report the fallthrough value

### Flag Naming Conventions

| Pattern | Type | Example |
|---------|------|---------|
| `poldeliver-{ticket}-{desc}` | Boolean feature flag (Jira-linked) | `poldeliver-2555-bd-tool-connector` |
| `{tool}-versions` | Multivariate JSON (recommended/supported/deprecated) | `coverity-versions` |
| `enable-{feature}` | Boolean feature toggle | `enable-superset` |

---

## Commands

### search

Search flags by key or name substring. The `query` filter is case-insensitive and matches against both key and name.

```bash
LD_AUTH=(-H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415")
QUERY="$1"

RESULT=$(/workspace/scripts/api.sh launchdarkly GET \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen?filter=query:${QUERY}&limit=20&sort=-creationDate" \
  "${LD_AUTH[@]}" 2>/dev/null)

python3 -c "
import sys, json
data = json.loads('''$RESULT_ESCAPED''')  # see note below
" << 'PYEOF'
import sys, json

data = json.load(sys.stdin)
items = data.get('items', [])
total = data.get('totalCount', len(items))
print(f'Found {total} flags matching \"{query}\"')
print()

for f in items:
    key = f['key']
    name = f.get('name', key)
    kind = f.get('kind', '?')
    tags = f.get('tags', [])

    # Quick env summary
    envs = []
    for ek in ['test', 'production']:
        env = f.get('environments', {}).get(ek, {})
        on = env.get('on', False)
        envs.append(f'{ek}={"ON" if on else "OFF"}')

    tag_str = f' [{", ".join(tags)}]' if tags else ''
    print(f'  `{key}` — {name} ({kind}){tag_str}')
    print(f'    {" | ".join(envs)}')
PYEOF
```

**Actual implementation** — pipe the API response into python:

```bash
LD_AUTH=(-H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415")
QUERY="$1"

/workspace/scripts/api.sh launchdarkly GET \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen?filter=query:${QUERY}&limit=20&sort=-creationDate" \
  "${LD_AUTH[@]}" 2>/dev/null | \
python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', [])
total = data.get('totalCount', len(items))

query = '${QUERY}'
print(f'Found {total} flags matching \"{query}\"')
print()

for f in items:
    key = f['key']
    name = f.get('name', key)
    kind = f.get('kind', '?')
    tags = f.get('tags', [])
    envs = []
    for ek in ['test', 'production']:
        env = f.get('environments', {}).get(ek, {})
        on = env.get('on', False)
        envs.append(f'{ek}={\"ON\" if on else \"OFF\"}')
    tag_str = f' [{chr(44).join(tags)}]' if tags else ''
    print(f'  {key} — {name} ({kind}){tag_str}')
    print(f'    {\" | \".join(envs)}')
"
```

**Additional filter options** (combine with comma):
- `filter=query:coveo,state:live` — only live flags matching "coveo"
- `filter=query:poldeliver,tags:release` — flags matching "poldeliver" with "release" tag
- `filter=query:coveo,state:archived` — find archived flags

**Sort options**: `creationDate`, `key`, `name`, `-creationDate` (descending), `-name`

### get

Get full flag detail with targeting analysis.

```bash
LD_AUTH=(-H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415")
FLAG_KEY="$1"
TARGET_POLARIS_ENV="$2"  # optional: im, co, cdev, etc.

/workspace/scripts/api.sh launchdarkly GET \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen/${FLAG_KEY}" \
  "${LD_AUTH[@]}" 2>/dev/null | \
python3 << 'PYEOF' - "${TARGET_POLARIS_ENV:-}"
import sys, json

target_env = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
data = json.load(sys.stdin)

key = data['key']
name = data.get('name', key)
kind = data.get('kind', 'boolean')
variations = data.get('variations', [])
tags = data.get('tags', [])
desc = data.get('description', '')
temporary = data.get('temporary', False)
created = data.get('creationDate', 0)

from datetime import datetime
created_str = datetime.fromtimestamp(created/1000).strftime('%Y-%m-%d') if created else '?'

print(f'Flag: {key}')
print(f'Name: {name}')
print(f'Kind: {kind} | Temporary: {temporary} | Created: {created_str}')
if desc: print(f'Description: {desc}')
if tags: print(f'Tags: {", ".join(tags)}')
print(f'Variations: {[v["value"] for v in variations]}')
print()

for env_key in ['test', 'production']:
    env = data.get('environments', {}).get(env_key, {})
    on = env.get('on', False)
    off_var_idx = env.get('offVariation', 1)
    off_val = variations[off_var_idx]['value'] if off_var_idx is not None and off_var_idx < len(variations) else 'N/A'
    version = env.get('version', '?')
    last_mod = env.get('lastModified', 0)
    last_mod_str = datetime.fromtimestamp(last_mod/1000).strftime('%Y-%m-%d %H:%M UTC') if last_mod else '?'

    print(f'--- {env_key}: {"ON" if on else "OFF"} (v{version}, modified {last_mod_str}) ---')

    if not on:
        print(f'  Serving: {off_val} (off variation) to all contexts')
        print()
        continue

    # Prerequisites
    prereqs = env.get('prerequisites', [])
    if prereqs:
        for p in prereqs:
            req_key = p.get('key', '?')
            req_var = p.get('variation', 0)
            print(f'  Prerequisite: {req_key} must be variation {req_var}')

    # Individual targets
    targets = env.get('targets', [])
    for t in targets:
        var_val = variations[t.get('variation', 0)]['value']
        vals = t.get('values', [])
        ctx_kind = t.get('contextKind', 'user')
        display = vals[:5]
        extra = f' +{len(vals)-5} more' if len(vals) > 5 else ''
        print(f'  Individual targets ({ctx_kind}) -> {var_val}: {display}{extra}')

    # Context targets
    ctx_targets = env.get('contextTargets', [])
    for ct in ctx_targets:
        vals = ct.get('values', [])
        if vals:
            ctx_kind = ct.get('contextKind', '?')
            var_val = variations[ct.get('variation', 0)]['value']
            print(f'  Context targets ({ctx_kind}) -> {var_val}: {vals[:5]}')

    # Rules
    rules = env.get('rules', [])
    env_values_in_rules = set()
    tenant_values_in_rules = set()
    rules_with_tenant = []

    for i, rule in enumerate(rules):
        rule_id = rule.get('_id', '?')
        disabled = rule.get('disabled', False)
        desc_r = rule.get('description', '')
        var_idx = rule.get('variation')
        rollout = rule.get('rollout')

        if var_idx is not None:
            var_val = variations[var_idx]['value']
        elif rollout:
            weights = rollout.get('variations', [])
            parts = [f'{variations[w["variation"]]["value"]}={w["weight"]/1000:.1f}%' for w in weights if w.get('weight', 0) > 0]
            var_val = f'rollout [{", ".join(parts)}]'
        else:
            var_val = '?'

        disabled_str = ' [DISABLED]' if disabled else ''
        desc_str = f' ({desc_r})' if desc_r else ''
        rule_has_tenant = False

        for clause in rule.get('clauses', []):
            attr = clause.get('attribute', '?')
            op = clause.get('op', 'in')
            vals = clause.get('values', [])
            negate = clause.get('negate', False)
            ctx_kind = clause.get('contextKind', '')
            neg_str = 'NOT ' if negate else ''
            ctx_str = f'[{ctx_kind}] ' if ctx_kind and ctx_kind != 'user' else ''
            print(f'  Rule {i}{desc_str}{disabled_str}: {ctx_str}{attr} {neg_str}{op} {vals} -> {var_val}')
            print(f'    (ruleId: {rule_id})')
            if attr == 'env':
                env_values_in_rules.update(vals)
            if attr == 'tenant':
                tenant_values_in_rules.update(vals)
                rule_has_tenant = True

        if rule_has_tenant:
            rules_with_tenant.append(i)

    if not rules:
        print(f'  No targeting rules')

    # Warn if rules use tenant-based targeting
    if rules_with_tenant:
        print(f'  ** Rules {rules_with_tenant} use tenant-based targeting — flag state depends on the org/tenant ID, not just the environment **')

    # Fallthrough
    ft = env.get('fallthrough', {})
    ft_var = ft.get('variation')
    ft_rollout = ft.get('rollout')
    if ft_var is not None:
        print(f'  Fallthrough: {variations[ft_var]["value"]}')
    elif ft_rollout:
        weights = ft_rollout.get('variations', [])
        parts = [f'{variations[w["variation"]]["value"]}={w["weight"]/1000:.1f}%' for w in weights if w.get('weight', 0) > 0]
        print(f'  Fallthrough: rollout [{", ".join(parts)}]')
    print()

    # If user asked about a specific Polaris env, check targeting
    if target_env and env_key == 'test':
        short = target_env.split('.')[0]
        if env_values_in_rules:
            matched = any(short == v or short == v.split('.')[0] for v in env_values_in_rules)
            if matched:
                # Find which rule and what value, noting tenant restrictions
                for i, rule in enumerate(rules):
                    env_match = False
                    has_tenant_clause = False
                    tenant_vals = []
                    for clause in rule.get('clauses', []):
                        if clause.get('attribute') == 'env':
                            clause_vals = clause.get('values', [])
                            if any(short == v or short == v.split('.')[0] for v in clause_vals):
                                env_match = True
                        if clause.get('attribute') == 'tenant':
                            has_tenant_clause = True
                            tenant_vals = clause.get('values', [])
                    if env_match:
                        var_idx = rule.get('variation')
                        val = variations[var_idx]['value'] if var_idx is not None else 'rollout'
                        if has_tenant_clause:
                            print(f'  -> {target_env} IS targeted by Rule {i} -> serves {val}')
                            print(f'     ** BUT only for tenants: {tenant_vals[:5]}{"..." if len(tenant_vals) > 5 else ""} **')
                            print(f'     Other tenants in {target_env} fall through to next matching rule or fallthrough')
                        else:
                            print(f'  -> {target_env} IS targeted by Rule {i} -> serves {val} (all tenants)')
                        break
            else:
                ft_val = variations[ft_var]['value'] if ft_var is not None else 'rollout'
                print(f'  -> {target_env} is NOT in any rule -> gets fallthrough ({ft_val})')
        else:
            ft_val = variations[ft_var]['value'] if ft_var is not None else 'rollout'
            print(f'  -> No env-based rules -> all contexts get fallthrough ({ft_val})')
        print()
PYEOF
```

If the flag is not found (exit code 1), fall back to search:

```bash
if [ $? -ne 0 ]; then
  echo "Flag '${FLAG_KEY}' not found. Searching..."
  # Run the search command with FLAG_KEY as query
fi
```

### compare

Side-by-side comparison of test vs production for a flag.

```bash
LD_AUTH=(-H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415")
FLAG_KEY="$1"

/workspace/scripts/api.sh launchdarkly GET \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen/${FLAG_KEY}" \
  "${LD_AUTH[@]}" 2>/dev/null | \
python3 << 'PYEOF'
import sys, json

data = json.load(sys.stdin)
key = data['key']
variations = data.get('variations', [])

print(f'Flag: {key}')
print(f'{"":30} {"test":20} {"production":20}')
print(f'{"-"*70}')

for field_name, get_fn in [
    ('Toggle', lambda e: 'ON' if e.get('on') else 'OFF'),
    ('Off variation', lambda e: str(variations[e.get('offVariation', 1)]['value']) if e.get('offVariation') is not None else 'N/A'),
    ('Rules count', lambda e: str(len(e.get('rules', [])))),
    ('Individual targets', lambda e: str(sum(len(t.get('values', [])) for t in e.get('targets', [])))),
    ('Prerequisites', lambda e: str(len(e.get('prerequisites', [])))),
    ('Version', lambda e: str(e.get('version', '?'))),
]:
    test_env = data.get('environments', {}).get('test', {})
    prod_env = data.get('environments', {}).get('production', {})
    test_val = get_fn(test_env)
    prod_val = get_fn(prod_env)
    diff = ' <-- DIFF' if test_val != prod_val else ''
    print(f'{field_name:30} {test_val:20} {prod_val:20}{diff}')

# Fallthrough comparison
for env_key in ['test', 'production']:
    env = data.get('environments', {}).get(env_key, {})
    ft = env.get('fallthrough', {})
    ft_var = ft.get('variation')
    ft_rollout = ft.get('rollout')
    if ft_var is not None:
        val = str(variations[ft_var]['value'])
    elif ft_rollout:
        val = 'rollout'
    else:
        val = '?'
    if env_key == 'test':
        test_ft = val
    else:
        prod_ft = val

diff = ' <-- DIFF' if test_ft != prod_ft else ''
print(f'{"Fallthrough":30} {test_ft:20} {prod_ft:20}{diff}')

# Show rules detail for each
print()
for env_key in ['test', 'production']:
    env = data.get('environments', {}).get(env_key, {})
    rules = env.get('rules', [])
    if rules:
        print(f'{env_key} rules:')
        for i, rule in enumerate(rules):
            var_idx = rule.get('variation')
            var_val = variations[var_idx]['value'] if var_idx is not None else 'rollout'
            has_tenant = False
            for clause in rule.get('clauses', []):
                attr = clause.get('attribute', '?')
                vals = clause.get('values', [])
                negate = 'NOT ' if clause.get('negate') else ''
                print(f'  Rule {i}: {attr} {negate}in {vals} -> {var_val}')
                if attr == 'tenant':
                    has_tenant = True
            if has_tenant:
                print(f'    ** tenant-restricted rule **')
        print()
PYEOF
```

### toggle

Toggle a flag on/off. **ALWAYS ask for user confirmation before executing.**

```bash
LD_AUTH=(-H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415")
FLAG_KEY="$1"
LD_ENV="$2"       # "test" or "production"
ACTION="$3"       # "on" or "off"

# Map action to boolean
if [ "$ACTION" = "on" ]; then
  VALUE="true"
else
  VALUE="false"
fi

/workspace/scripts/api.sh launchdarkly PATCH \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen/${FLAG_KEY}" \
  "${LD_AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d "[{\"op\": \"replace\", \"path\": \"/environments/${LD_ENV}/on\", \"value\": ${VALUE}}]"
```

**Semantic patch alternative** (preferred for clarity):
```bash
/workspace/scripts/api.sh launchdarkly PATCH \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen/${FLAG_KEY}" \
  "${LD_AUTH[@]}" \
  -H "Content-Type: application/json; domain-model=launchdarkly.semanticpatch" \
  -d "{\"comment\": \"Toggled ${ACTION} by deployment agent\", \"environmentKey\": \"${LD_ENV}\", \"instructions\": [{\"kind\": \"turnFlag$(echo ${ACTION} | sed 's/^./\U&/')\"}]}"
```

**Rules:**
- **test environment**: May toggle with user approval
- **production environment**: ALWAYS confirm with user, include `comment` field (production requires comments)
- **Never auto-toggle** — always report and ask first

### update-fallthrough

Change the default (fallthrough) variation for an environment.

```bash
LD_AUTH=(-H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415")
FLAG_KEY="$1"
LD_ENV="$2"           # "test" or "production"
VARIATION_INDEX="$3"  # 0 for true, 1 for false (for boolean flags)

# First, get the variation ID
VAR_ID=$(/workspace/scripts/api.sh launchdarkly GET \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen/${FLAG_KEY}" \
  "${LD_AUTH[@]}" 2>/dev/null | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['variations'][${VARIATION_INDEX}]['_id'])")

/workspace/scripts/api.sh launchdarkly PATCH \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen/${FLAG_KEY}" \
  "${LD_AUTH[@]}" \
  -H "Content-Type: application/json; domain-model=launchdarkly.semanticpatch" \
  -d "{\"comment\": \"Updated fallthrough to variation ${VARIATION_INDEX}\", \"environmentKey\": \"${LD_ENV}\", \"instructions\": [{\"kind\": \"updateFallthroughVariationOrRollout\", \"variationId\": \"${VAR_ID}\"}]}"
```

### add-env-target

Add Polaris environment values to a rule's `env` clause. Useful for enabling a flag for additional environments.

```bash
LD_AUTH=(-H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415")
FLAG_KEY="$1"
LD_ENV="$2"         # "test" or "production"
RULE_INDEX="$3"     # 0-based rule index
shift 3
ENV_VALUES="$@"     # space-separated env values: im co stg

# Get the current rule details (need ruleId and clauseId)
/workspace/scripts/api.sh launchdarkly GET \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen/${FLAG_KEY}" \
  "${LD_AUTH[@]}" 2>/dev/null | \
python3 << PYEOF - "${LD_ENV}" "${RULE_INDEX}" ${ENV_VALUES}
import sys, json

args = sys.argv[1:]
ld_env = args[0]
rule_idx = int(args[1])
new_envs = args[2:]

data = json.load(sys.stdin)
env = data['environments'][ld_env]
rule = env['rules'][rule_idx]
rule_id = rule['_id']

# Find the env clause
for clause in rule.get('clauses', []):
    if clause.get('attribute') == 'env':
        clause_id = clause['_id']
        current_vals = clause.get('values', [])
        merged = list(set(current_vals + new_envs))
        print(f'Rule ID: {rule_id}')
        print(f'Clause ID: {clause_id}')
        print(f'Current values: {current_vals}')
        print(f'New values: {merged}')
        print(f'MERGED:{json.dumps(merged)}')
        break
PYEOF

# Then apply the update using JSON Patch:
# /workspace/scripts/api.sh launchdarkly PATCH \
#   "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen/${FLAG_KEY}" \
#   "${LD_AUTH[@]}" \
#   -H "Content-Type: application/json" \
#   -d "[{\"op\": \"replace\", \"path\": \"/environments/${LD_ENV}/rules/${RULE_INDEX}/clauses/0/values\", \"value\": ${MERGED_JSON}}]"
```

### audit

Flag metadata, evaluation status, code references, and recent modifications.

```bash
LD_AUTH=(-H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415")
FLAG_KEY="$1"

# Get flag detail
FLAG=$(/workspace/scripts/api.sh launchdarkly GET \
  "https://app.launchdarkly.com/api/v2/flags/polaris-nextgen/${FLAG_KEY}" \
  "${LD_AUTH[@]}" 2>/dev/null)

# Get flag status (evaluation activity)
STATUS=$(/workspace/scripts/api.sh launchdarkly GET \
  "https://app.launchdarkly.com/api/v2/flag-status/polaris-nextgen/${FLAG_KEY}" \
  "${LD_AUTH[@]}" 2>/dev/null)

# Get code references
CODE_REFS=$(/workspace/scripts/api.sh launchdarkly GET \
  "https://app.launchdarkly.com/api/v2/code-refs/statistics/polaris-nextgen?flagKey=${FLAG_KEY}" \
  "${LD_AUTH[@]}" 2>/dev/null)

python3 << 'PYEOF'
import sys, json
from datetime import datetime

flag = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
status = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
refs = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
PYEOF

# Better: pipe combined JSON
echo "{\"flag\": ${FLAG}, \"status\": ${STATUS}, \"refs\": ${CODE_REFS}}" | \
python3 << 'PYEOF'
import sys, json
from datetime import datetime

combined = json.load(sys.stdin)
flag = combined.get('flag', {})
status = combined.get('status', {})
refs = combined.get('refs', {})

key = flag.get('key', '?')
name = flag.get('name', key)
kind = flag.get('kind', '?')
tags = flag.get('tags', [])
temporary = flag.get('temporary', False)
created = flag.get('creationDate', 0)
created_str = datetime.fromtimestamp(created/1000).strftime('%Y-%m-%d') if created else '?'
desc = flag.get('description', '')
maintainer = flag.get('_maintainer', {})
maintainer_name = maintainer.get('firstName', '') + ' ' + maintainer.get('lastName', '') if maintainer else 'unassigned'
maintainer_email = maintainer.get('email', '')

print(f'=== AUDIT: {key} ===')
print(f'Name: {name}')
print(f'Kind: {kind} | Temporary: {temporary} | Created: {created_str}')
if desc: print(f'Description: {desc}')
if tags: print(f'Tags: {", ".join(tags)}')
print(f'Maintainer: {maintainer_name.strip()} ({maintainer_email})')
print()

# Status per environment
print('--- Evaluation Status ---')
for env_key, env_status in status.get('environments', {}).items():
    status_name = env_status.get('name', '?')
    last_req = env_status.get('lastRequested', 'never')
    if last_req and last_req != 'never':
        last_req = last_req[:19].replace('T', ' ') + ' UTC'
    print(f'  {env_key}: {status_name} (last evaluated: {last_req})')
print()

# Environment config summary
print('--- Environment Config ---')
variations = flag.get('variations', [])
for env_key in ['test', 'production']:
    env = flag.get('environments', {}).get(env_key, {})
    on = env.get('on', False)
    version = env.get('version', '?')
    last_mod = env.get('lastModified', 0)
    mod_str = datetime.fromtimestamp(last_mod/1000).strftime('%Y-%m-%d %H:%M UTC') if last_mod else '?'
    rules_count = len(env.get('rules', []))
    targets_count = sum(len(t.get('values', [])) for t in env.get('targets', []))
    print(f'  {env_key}: {"ON" if on else "OFF"} | v{version} | modified {mod_str} | {rules_count} rules, {targets_count} individual targets')
print()

# Code references
print('--- Code References ---')
if refs:
    flag_refs = refs.get('flags', {}).get(key, {})
    if flag_refs:
        for repo_name, repo_refs in flag_refs.items():
            count = repo_refs.get('count', 0)
            print(f'  {repo_name}: {count} references')
    else:
        print('  No code references found')
else:
    print('  Code references data unavailable')
PYEOF
```

**Status values explained:**
- `new` — recently created, not yet evaluated
- `active` — evaluated within the last 7 days
- `inactive` — not evaluated in the last 7 days
- `launched` — ON in this environment and has been evaluated (stable rollout)

### list-stale

Find flags that haven't been evaluated recently — candidates for cleanup.

```bash
LD_AUTH=(-H "Authorization: $LAUNCHDARKLY_API_KEY" -H "Ld-Api-Version: 20240415")

# Get all flag statuses for test environment
/workspace/scripts/api.sh launchdarkly GET \
  "https://app.launchdarkly.com/api/v2/flag-statuses/polaris-nextgen/test" \
  "${LD_AUTH[@]}" 2>/dev/null | \
python3 << 'PYEOF'
import sys, json
from datetime import datetime, timezone

data = json.load(sys.stdin)
items = data.get('items', data if isinstance(data, list) else [])

stale = []
for item in items:
    links = item.get('_links', {})
    flag_link = links.get('parent', {}).get('href', '')
    flag_key = flag_link.split('/')[-1] if flag_link else '?'

    status_name = item.get('name', '?')
    last_req = item.get('lastRequested', '')

    if status_name == 'inactive' or not last_req:
        stale.append((flag_key, status_name, last_req or 'never'))

print(f'Found {len(stale)} inactive/never-evaluated flags in test environment')
print()
for key, status, last in sorted(stale)[:30]:
    print(f'  {key}: {status} (last: {last[:10] if last != "never" else last})')

if len(stale) > 30:
    print(f'  ... and {len(stale) - 30} more')
PYEOF
```

---

## Modification Policy

| Action | test env | production env |
|--------|----------|----------------|
| Read (get, search, compare, audit) | Always allowed | Always allowed |
| Toggle on/off | User approval required | User approval + comment required |
| Update rules/fallthrough | User approval required | User approval + comment required |
| Archive/delete | User approval required | User approval + comment required |

**Never auto-modify flags.** Always report findings and ask the user before making changes.

## Error Handling

| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| 401 | Invalid API key | Report — token may be expired. Use `request_credential` if needed |
| 403 | Insufficient permissions | Report — API key may lack write access |
| 404 | Flag or project not found | Fall back to search to suggest alternatives |
| 405 | Approval required | Report — this environment requires approval workflows in LD UI |
| 409 | Conflict with pending changes | Report — there are pending scheduled changes or approval requests |
| 429 | Rate limited | Back off and retry after delay |

## Notes

- The `test` LD environment covers ALL non-production Polaris envs
- A flag being ON does NOT mean it serves `true` — check rules and fallthrough
- **Two custom context attributes are used for targeting**: `env` (hostname/environment) and `tenant` (organization ID). Rules may target by either or both.
- When reporting flag state for a specific environment, always note if rules also restrict by `tenant` — the flag may be active for that environment but only for certain tenants
- The `env` attribute value is typically the full hostname (e.g., `im.dev.polaris.blackduck.com`) but rules may also use short names (`im`). Check both forms.
- Production changes require `comment` field in the patch request
- Use `filter=query:<term>` syntax (NOT `filter=query equals "<term>"`)
- The `summary=0` query param with `env=<envKey>` returns full targeting detail in list responses
- Semantic patches (`Content-Type: application/json; domain-model=launchdarkly.semanticpatch`) are preferred for modifications as they're more readable and support comments natively
