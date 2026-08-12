/** Use a Redis token only when it actually changed. Empty/same → no retry. */
export function newerContextToken(
  current: string,
  latest: string | null | undefined,
): string | null {
  const next = latest?.trim() ?? "";
  if (!next || next === current) return null;
  return next;
}
