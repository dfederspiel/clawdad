#!/usr/bin/env node
// Validate SKILL.md files against the rules in CONTRIBUTING.md:
//   - Frontmatter (`---` block) required
//   - `name` and `description` keys required
//   - `name` matches the skill's directory
//   - File length <= MAX_LINES
//
// Usage:
//   node scripts/validate-skills.mjs                       # audit every SKILL.md
//   node scripts/validate-skills.mjs path/to/SKILL.md ...  # validate specific files

import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 500;
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
  const rel = path.relative(process.cwd(), filePath);
  const dirName = path.basename(path.dirname(filePath));

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return [`${rel}: cannot read file (${err.message})`];
  }

  const lines = content.split('\n');
  if (lines.length > MAX_LINES) {
    errors.push(
      `${rel}: ${lines.length} lines exceeds the ${MAX_LINES}-line limit — move detail to a reference file`,
    );
  }

  if (lines[0] !== '---') {
    errors.push(
      `${rel}: missing frontmatter — file must start with "---" on the first line`,
    );
    return errors;
  }

  const closeIdx = lines.indexOf('---', 1);
  if (closeIdx === -1) {
    errors.push(`${rel}: frontmatter has no closing "---"`);
    return errors;
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

  return errors;
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
for (const file of targets) {
  allErrors.push(...validate(file));
}

if (allErrors.length > 0) {
  console.error(`skill validation failed (${allErrors.length} issue(s)):\n`);
  for (const e of allErrors) console.error(`  • ${e}`);
  process.exit(1);
}

console.log(`✓ ${targets.length} skill file(s) pass validation.`);
