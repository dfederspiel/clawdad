#!/usr/bin/env node
// Validate SKILL.md files against the rules in CONTRIBUTING.md:
//   - Frontmatter (`---` block) required
//   - `name` and `description` keys required
//   - `name` matches the skill's directory
//   - File length <= MAX_LINES
//
// Also emits soft warnings (non-failing) for skills over the Claude Code
// compaction threshold (~150 lines / ~5K tokens each) where content past
// that point may be silently truncated during long conversations. See #50.
//
// Usage:
//   node scripts/validate-skills.mjs                       # audit every SKILL.md
//   node scripts/validate-skills.mjs path/to/SKILL.md ...  # validate specific files

import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 500;
const COMPACTION_SOFT_WARNING = 150;
const SKILL_ROOTS = ['.claude/skills', 'container/skills'];

function findAllSkills() {
  const results = [];
  for (const root of SKILL_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(root, entry.name, 'SKILL.md');
      if (fs.existsSync(skillMd)) results.push(skillMd);
    }
  }
  return results;
}

function validate(filePath) {
  const errors = [];
  const warnings = [];
  const rel = path.relative(process.cwd(), filePath);
  const dirName = path.basename(path.dirname(filePath));

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { errors: [`${rel}: cannot read file (${err.message})`], warnings };
  }

  const lines = content.split('\n');
  if (lines.length > MAX_LINES) {
    errors.push(
      `${rel}: ${lines.length} lines exceeds the ${MAX_LINES}-line limit — move detail to a reference file`,
    );
  } else if (lines.length > COMPACTION_SOFT_WARNING) {
    warnings.push(
      `${rel}: ${lines.length} lines exceeds the ${COMPACTION_SOFT_WARNING}-line compaction threshold — content past line ${COMPACTION_SOFT_WARNING} may be silently truncated by Claude Code. Put critical rules above that point or lift them into a CLAUDE.md layer (see /context-audit).`,
    );
  }

  if (lines[0] !== '---') {
    errors.push(
      `${rel}: missing frontmatter — file must start with "---" on the first line`,
    );
    return { errors, warnings };
  }

  const closeIdx = lines.indexOf('---', 1);
  if (closeIdx === -1) {
    errors.push(`${rel}: frontmatter has no closing "---"`);
    return { errors, warnings };
  }

  const fm = lines.slice(1, closeIdx);
  const nameMatch = fm.find((l) => /^name\s*:/.test(l));
  const descMatch = fm.find((l) => /^description\s*:/.test(l));

  if (!nameMatch) {
    errors.push(`${rel}: frontmatter missing required "name" field`);
  } else {
    const name = nameMatch.replace(/^name\s*:\s*/, '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      errors.push(
        `${rel}: name "${name}" must be lowercase alphanumeric with hyphens, ≤64 chars`,
      );
    }
    if (name !== dirName) {
      errors.push(
        `${rel}: name "${name}" does not match directory "${dirName}"`,
      );
    }
  }
  if (!descMatch) {
    errors.push(`${rel}: frontmatter missing required "description" field`);
  }

  return { errors, warnings };
}

const args = process.argv.slice(2);
const targets =
  args.length > 0
    ? args.filter((f) => f.endsWith('SKILL.md'))
    : findAllSkills();

if (targets.length === 0) {
  console.log('No SKILL.md files to validate.');
  process.exit(0);
}

const allErrors = [];
const allWarnings = [];
for (const file of targets) {
  const { errors, warnings } = validate(file);
  allErrors.push(...errors);
  allWarnings.push(...warnings);
}

if (allWarnings.length > 0) {
  console.warn(
    `skill compaction warnings (${allWarnings.length}; non-blocking):\n`,
  );
  for (const w of allWarnings) console.warn(`  • ${w}`);
  console.warn('');
}

if (allErrors.length > 0) {
  console.error(`skill validation failed (${allErrors.length} issue(s)):\n`);
  for (const e of allErrors) console.error(`  • ${e}`);
  process.exit(1);
}

console.log(`✓ ${targets.length} skill file(s) pass validation.`);
