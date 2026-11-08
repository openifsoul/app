/** Loopback has no remote identity service; browser-origin checks protect reads too. */
export function trustedLocalRequest(
  request: Request,
  expectedOrigin: string,
): boolean {
  const url = new URL(request.url);
  const expected = new URL(expectedOrigin);
  if (
    expected.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(expected.hostname) ||
    url.origin !== expected.origin
  )
    return false;
  const host = request.headers.get("host");
  if (host !== expected.host) return false;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== expected.origin) return false;
  if (!["GET", "HEAD"].includes(request.method) && origin !== expected.origin)
    return false;
  const site = request.headers.get("sec-fetch-site");
  return site === null || ["same-origin", "none"].includes(site);
}
export function appConfig(mode: "local" | "cloud", requestTimeoutMs?: number) {
  return {
    mode,
    auth: mode === "local" ? "local" : "external",
    laboratory: mode === "local",
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  };
}
