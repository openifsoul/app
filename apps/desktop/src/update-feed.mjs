import { createHash, createPublicKey, verify } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const product = "org.openifsoul.desktop";
export const updateProtocol = 1;
export const distributionPolicy = "ifsoul-ed25519-v1";
export const dataFormat = "0.4.0";
export const bridgeProtocol = "0.4.0";
const maxManifestBytes = 32 * 1024;
const maxArtifactBytes = 1024 * 1024 * 1024;

function httpsURL(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw Error(
      "Desktop updates require HTTPS without credentials or fragments.",
    );
  return url;
}

async function get(url, timeout, fetcher) {
  const response = await fetcher(url, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok || !response.body)
    throw Error("Desktop update request failed.");
  return response.body;
}

function versionParts(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)
  )
    throw Error("Invalid Desktop release version.");
  return value.split(".").map(Number);
}

function newer(candidate, installed) {
  const a = versionParts(candidate);
  const b = versionParts(installed);
  const difference = a.findIndex((part, index) => part !== b[index]);
  return difference !== -1 && a[difference] > b[difference];
}

export async function checkUpdate(
  { feed, publicKey, currentVersion, distribution },
  fetcher = fetch,
  now = Date.now(),
) {
  const url = httpsURL(feed);
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519")
    throw Error("Desktop feed requires an Ed25519 key.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of await get(url, 5000, fetcher)) {
    bytes += chunk.length;
    if (bytes > maxManifestBytes)
      throw Error("Desktop update manifest is too large.");
    chunks.push(chunk);
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    typeof envelope.payload !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(envelope.payload) ||
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)
  )
    throw Error("Invalid Desktop update envelope.");
  const payload = Buffer.from(envelope.payload, "base64url");
  if (!verify(null, payload, key, Buffer.from(envelope.signature, "base64url")))
    throw Error("Desktop update signature is invalid.");
  const release = JSON.parse(payload.toString("utf8"));
  if (
    release.product !== product ||
    release.protocol !== updateProtocol ||
    release.distribution !== distribution ||
    release.platform !== "darwin" ||
    release.arch !== "arm64" ||
    release.dataFormat !== dataFormat ||
    release.rollbackCompatible !== true ||
    !release.bridges ||
    typeof release.bridges !== "object" ||
    Array.isArray(release.bridges) ||
    Object.keys(release.bridges).length !== 1 ||
    release.bridges["minecraft-mineflayer"]?.protocol !== bridgeProtocol ||
    !/^[a-f0-9]{64}$/.test(
      release.bridges["minecraft-mineflayer"]?.sha256 ?? "",
    ) ||
    !Number.isSafeInteger(release.expiresAt) ||
    release.expiresAt <= now ||
    release.expiresAt > now + 14 * 86400000 ||
    typeof release.artifact !== "string" ||
    !Number.isSafeInteger(release.bytes) ||
    release.bytes < 1 ||
    release.bytes > maxArtifactBytes ||
    typeof release.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(release.sha256)
  )
    throw Error("Desktop update is expired or incompatible.");
  const artifact = httpsURL(new URL(release.artifact, url));
  if (artifact.origin !== url.origin)
    throw Error("Desktop update must use the feed origin.");
  if (!newer(release.version, currentVersion)) return null;
  return { ...release, artifact };
}

export async function downloadUpdate(release, destination, fetcher = fetch) {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > release.bytes)
        return callback(Error("Desktop update is too large."));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const body = await get(httpsURL(release.artifact), 120000, fetcher);
  await pipeline(
    Readable.fromWeb(body),
    stream,
    createWriteStream(destination, { mode: 0o600, flags: "wx" }),
  );
  if (bytes !== release.bytes || hash.digest("hex") !== release.sha256)
    throw Error("Desktop update checksum or length is invalid.");
}
