// Pure helpers for showing org units as an indented tree. Rows come from the
// server, and bad data (a cycle, a parent that is missing or hidden by scope)
// must never hang or drop a unit, so every walk is visited-set guarded.

export interface TreeUnit {
  uuid: string;
  name: string;
  parentUuid: string | null;
}

interface TreeRow<T extends TreeUnit> {
  unit: T;
  depth: number;
}

const MAX_DEPTH = 64;
const byName = (a: TreeUnit, b: TreeUnit) => a.name.localeCompare(b.name, 'da') || a.uuid.localeCompare(b.uuid);

/** Depth-first order, siblings by name. Units whose parent is not in the list are roots. */
export function flattenOrgTree<T extends TreeUnit>(units: readonly T[]): TreeRow<T>[] {
  const known = new Set(units.map((u) => u.uuid));
  const children = new Map<string | null, T[]>();
  for (const u of units) {
    const key = u.parentUuid !== null && known.has(u.parentUuid) && u.parentUuid !== u.uuid ? u.parentUuid : null;
    const list = children.get(key);
    if (list) list.push(u);
    else children.set(key, [u]);
  }
  for (const list of children.values()) list.sort(byName);

  const rows: TreeRow<T>[] = [];
  const seen = new Set<string>();
  const stack: TreeRow<T>[] = [...(children.get(null) ?? [])].reverse().map((unit) => ({ unit, depth: 0 }));
  while (stack.length > 0) {
    const row = stack.pop()!;
    if (seen.has(row.unit.uuid)) continue;
    seen.add(row.unit.uuid);
    rows.push(row);
    const kids = children.get(row.unit.uuid) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ unit: kids[i], depth: Math.min(row.depth + 1, MAX_DEPTH) });
    }
  }
  // Units only reachable through a cycle: still listed, as roots, so they can be fixed.
  for (const u of [...units].sort(byName)) {
    if (!seen.has(u.uuid)) {
      seen.add(u.uuid);
      rows.push({ unit: u, depth: 0 });
    }
  }
  return rows;
}

/** The unit itself plus everything below it (used to keep a move from offering a cycle). */
export function selfAndDescendants(units: readonly TreeUnit[], uuid: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const u of units) {
    if (u.parentUuid === null) continue;
    const list = children.get(u.parentUuid);
    if (list) list.push(u.uuid);
    else children.set(u.parentUuid, [u.uuid]);
  }
  const out = new Set<string>([uuid]);
  const queue = [uuid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/** Label with em-space indentation so a plain <option> reads as a hierarchy. */
export function indentedLabel(name: string, depth: number): string {
  return depth > 0 ? `${'\u2003'.repeat(depth)}└ ${name}` : name;
}
