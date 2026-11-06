// Shared working-tree, Git-index and distribution-text guardrail. Not a full secret detector.
export const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  /\bsk_(?:test|live)_[A-Za-z0-9_-]{16,}\b/,
  /\bGOCSPX-[A-Za-z0-9_-]{12,}\b/,
  /\bBearer\s+[A-Za-z0-9_.=-]{24,}/,
];
const assignments =
  /(?<![A-Za-z0-9_$.-])["']?(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|cloudflareApiToken|cloudflareToken|ENCRYPTION_KEY|encryptionKey|CLERK_SECRET_KEY|GOOGLE_CLIENT_SECRET|client_secret|password|ownerPassword|apiKey|api_key|access_token|refresh_token)["']?\s*[:=]\s*(["'`])([^"'`\r\n]{16,})\1/g;
const synthetic =
  /^(?:(?:synthetic|test|fixture|example|demo|not-a-real|only-a-synthetic|replace-me|replace-with|your)[-_:\s]|<[^>]+>$|\$\{?[A-Z0-9_]+\}?$)/i;
export function hasPotentialSecret(text) {
  if (secretPatterns.some((pattern) => pattern.test(text))) return true;
  return [...text.matchAll(assignments)].some(
    (match) => !synthetic.test(match[2]),
  );
}
