// Sort rules for the sidebar group list.
//
// Regardless of the chosen mode:
//   1. The main group (isMain === true) is always pinned first.
//   2. Non-main system groups (isSystem && !isMain) are pinned last.
//   3. User groups fill the middle, ordered by the selected mode.
//
// Supported modes:
//   - 'name'     : case-insensitive alphabetical by name (default, legacy behavior)
//   - 'recent'   : most-recently-active first (lastActivity DESC, never-active last)
//   - 'upcoming' : soonest scheduled task first (nextTaskAt ASC, never-scheduled last)

function bucket(group) {
  if (group.isMain) return 0;
  if (group.isSystem) return 2;
  return 1;
}

function nameCompare(a, b) {
  return (a.name || '').localeCompare(b.name || '', undefined, {
    sensitivity: 'base',
  });
}

function effectiveActivity(group, override) {
  const server = group.lastActivity || null;
  const live = override && override[group.jid];
  if (server && live) return server > live ? server : live;
  return live || server;
}

function makeRecentCompare(override) {
  return function recentCompare(a, b) {
    const av = effectiveActivity(a, override);
    const bv = effectiveActivity(b, override);
    const al = av ? Date.parse(av) : -Infinity;
    const bl = bv ? Date.parse(bv) : -Infinity;
    if (al === bl) return nameCompare(a, b);
    return bl - al;
  };
}

function upcomingCompare(a, b) {
  const an = a.nextTaskAt ? Date.parse(a.nextTaskAt) : Infinity;
  const bn = b.nextTaskAt ? Date.parse(b.nextTaskAt) : Infinity;
  if (an === bn) return nameCompare(a, b);
  return an - bn;
}

function pickComparator(mode, override) {
  if (mode === 'recent') return makeRecentCompare(override);
  if (mode === 'upcoming') return upcomingCompare;
  return nameCompare;
}

export function sortGroups(groups, mode = 'name', override = null) {
  const cmp = pickComparator(mode, override);
  return [...groups].sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    return cmp(a, b);
  });
}
