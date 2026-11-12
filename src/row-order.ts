const POSITION_STEP = 1024;

/** Keep surviving rows byte-for-byte stable when an array is filtered.
 * Rebalance only for explicit reorders, exhausted gaps or unsafe integers. */
export function stableEntityPositions(ids: readonly string[], saved: ReadonlyMap<string, number>): number[] {
  const rebalance = () => ids.map((_, i) => i * POSITION_STEP);
  const positions = ids.map(id => saved.get(id));
  let last = -Infinity;
  for (const position of positions) {
    if (position === undefined) continue;
    if (!Number.isSafeInteger(position) || position <= last) return rebalance();
    last = position;
  }
  for (let start = 0; start < positions.length;) {
    if (positions[start] !== undefined) { start++; continue; }
    let end = start + 1;
    while (end < positions.length && positions[end] === undefined) end++;
    const left = start ? positions[start - 1] : undefined, right = positions[end], count = end - start;
    const step = left !== undefined && right !== undefined
      ? Math.floor((right - left) / (count + 1)) : POSITION_STEP;
    if (step < 1) return rebalance();
    const first = left !== undefined ? left + step : right !== undefined ? right - count * step : 0;
    for (let i = start; i < end; i++) {
      const value = first + (i - start) * step;
      if (!Number.isSafeInteger(value) || (left !== undefined && value <= left) || (right !== undefined && value >= right))
        return rebalance();
      positions[i] = value;
    }
    start = end;
  }
  return positions as number[];
}
