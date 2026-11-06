/** Private owner-laboratory authentication. No credential is returned to clients. */
const bytes = (text: string) => new TextEncoder().encode(text);
const b64 = (data: Uint8Array) =>
  btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const un64 = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
async function key(secret: string, usage: "HMAC" | "AES-GCM") {
  const material = await crypto.subtle.digest(
    "SHA-256",
    bytes(`ifsoul:${usage}:${secret}`),
  );
  return crypto.subtle.importKey(
    "raw",
    material,
    usage === "HMAC" ? { name: "HMAC", hash: "SHA-256" } : { name: "AES-GCM" },
    false,
    usage === "HMAC" ? ["sign", "verify"] : ["encrypt", "decrypt"],
  );
}
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const k = await key(b, "HMAC");
  const tag = await crypto.subtle.sign("HMAC", k, bytes(b));
  return crypto.subtle.verify("HMAC", k, tag, bytes(a));
}
export async function sessionCookie(
  secret: string,
  secure: boolean,
  now = Date.now(),
) {
  const value = b64(
    bytes(
      JSON.stringify({
        exp: now + 12 * 60 * 60 * 1000,
        nonce: crypto.randomUUID(),
      }),
    ),
  );
  const tag = b64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", await key(secret, "HMAC"), bytes(value)),
    ),
  );
  return `ifsoul_session=${value}.${tag}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? "; Secure" : ""}`;
}
export async function authenticated(
  request: Request,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    const value = request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("ifsoul_session="))
      ?.slice(15);
    if (!value) return false;
    const [body, tag, ...rest] = value.split(".");
    if (rest.length || !body || !tag || body.length > 512) return false;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await key(secret, "HMAC"),
        un64(tag),
        bytes(body),
      ))
    )
      return false;
    const data = JSON.parse(new TextDecoder().decode(un64(body)));
    return (
      Number.isFinite(data.exp) && data.exp > now && data.exp <= now + 43200000
    );
  } catch {
    return false;
  }
}
export async function encryptCredential(
  value: string,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: bytes("ifsoul-openai-v1") },
    await key(secret, "AES-GCM"),
    bytes(value),
  );
  return `${b64(iv)}.${b64(new Uint8Array(encrypted))}`;
}
export async function decryptCredential(
  value: string,
  secret: string,
): Promise<string> {
  const [iv, data] = value.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: un64(iv),
        additionalData: bytes("ifsoul-openai-v1"),
      },
      await key(secret, "AES-GCM"),
      un64(data),
    ),
  );
}
export async function boundedJSON(
  request: Request,
  max = 16384,
): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw Error("content-type");
  const reader = request.body?.getReader();
  if (!reader) throw Error("body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) throw Error("body");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}
export function secured(response: Response): Response {
  const r = new Response(response.body, response);
  r.headers.set("Cache-Control", "no-store");
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set("Referrer-Policy", "no-referrer");
  r.headers.set("X-Frame-Options", "DENY");
  r.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return r;
}
