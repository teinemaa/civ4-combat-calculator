/**
 * Sort UNITS for display in the unit selector grid.
 *
 * Order:
 *   1. Base units sorted by cost ASC, strength ASC, name ASC
 *   2. Each base unit is immediately followed by its UUs,
 *      sorted by cost ASC, strength ASC, name ASC
 */
export function sortUnitsForDisplay(units) {
  const byId = Object.fromEntries(units.map(u => [u.id, u]));

  const baseUnits = units.filter(u => !u.replaces);
  const uusByBase = {};
  for (const u of units) {
    if (!u.replaces) continue;
    if (!uusByBase[u.replaces]) uusByBase[u.replaces] = [];
    uusByBase[u.replaces].push(u);
  }

  const cmp = (a, b) =>
    a.cost - b.cost || a.strength - b.strength || a.name.localeCompare(b.name);

  baseUnits.sort(cmp);
  for (const list of Object.values(uusByBase)) list.sort(cmp);

  const result = [];
  for (const base of baseUnits) {
    result.push(base);
    for (const uu of (uusByBase[base.id] || [])) result.push(uu);
  }
  return result;
}
