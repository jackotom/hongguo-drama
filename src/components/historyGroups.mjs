// Display-only relationships: manual decisions never affect update checks or notifications.
export function groupHistory(rows, decisions = {}) {
  const parent = new Map(rows.map(row => [row.series_id, row.series_id]));
  const source = id => /^\d+$/.test(id) ? 'hongguo' : String(id).split(':').slice(0, /^(xifan|custom):/.test(id) ? 2 : 1).join(':');
  const validTarget = id => typeof decisions[id] === 'string' && parent.has(decisions[id]) && source(id) === source(decisions[id]) && decisions[decisions[id]] !== null;
  const root = id => {
    const path = [];
    while (parent.get(id) !== id) { path.push(id); id = parent.get(id); }
    for (const child of path) parent.set(child, id);
    return id;
  };
  const join = (a, b) => { if (parent.has(a) && parent.has(b)) parent.set(root(b), root(a)); };
  const families = new Map();
  for (const row of rows) {
    if (decisions[row.series_id] === null || validTarget(row.series_id)) continue;
    if (row.family) {
      const family = `${source(row.series_id)}\0${row.family}`;
      if (families.has(family)) join(row.series_id, families.get(family));
      else families.set(family, row.series_id);
    }
  }
  for (const [id, target] of Object.entries(decisions)) if (validTarget(id)) join(id, target);
  const groups = new Map();
  for (const row of rows) {
    const key = root(row.series_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(items => items.sort((a,b) => (b.season || 1) - (a.season || 1) || b.updatedAt - a.updatedAt));
}

export function historyGroupSuggestions(items) {
  const members = new Set(items.map(row => row.series_id));
  const sequels = new Map(), similar = new Map();
  let hasUnreadSequels = false;
  for (const row of items) {
    for (const candidate of row.sequels || []) {
      if (members.has(candidate.series_id)) continue;
      if (!sequels.has(candidate.series_id)) sequels.set(candidate.series_id, { ...candidate, origin: row });
      if (row.unreadSequelIds?.includes(candidate.series_id)) hasUnreadSequels = true;
    }
    for (const candidate of row.similarSeries || []) {
      if (!members.has(candidate.series_id) && !similar.has(candidate.series_id)) similar.set(candidate.series_id, { ...candidate, origin: row });
    }
  }
  return { sequels: [...sequels.values()], similarSeries: [...similar.values()].filter(candidate => !sequels.has(candidate.series_id)), hasUnreadSequels };
}
