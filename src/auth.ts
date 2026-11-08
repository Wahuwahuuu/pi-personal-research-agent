export async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function bearer(r: Request) {
  return (
    r.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/)?.[1] ?? null
  );
}
export function sameOrigin(r: Request) {
  const origin = r.headers.get("Origin");
  return !origin || origin === new URL(r.url).origin;
}
export function cookie(r: Request) {
  return (
    r.headers
      .get("Cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("pra_session="))
      ?.slice(12) ?? null
  );
}
export async function equal(a: string, b: string) {
  const x = await digest(a),
    y = await digest(b);
  let mismatch = 0;
  for (let i = 0; i < x.length; i++)
    mismatch |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return mismatch === 0;
}
