/** Shanghai billing boundaries only; a wake-up still has to pass the live budget ledger. */
export function nextBudgetWindow(
  code: string | undefined,
  now: number,
): number | undefined {
  const local = new Date(now + 8 * 3600000);
  if (code === "BACKGROUND_DAILY_BUDGET")
    return (
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate() + 1,
      ) -
      8 * 3600000
    );
  if (code === "MONTHLY_BUDGET" || code === "BACKGROUND_BUDGET")
    return (
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - 8 * 3600000
    );
  return undefined;
}
