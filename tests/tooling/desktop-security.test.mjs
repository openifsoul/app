import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appOrigin,
  desktopLoopbackOrigins,
  isOrigin,
  validatedServiceOrigin,
} from "../../apps/desktop/src/security.mjs";

test("desktop opens an explicit credential-free HTTPS service origin", () => {
  assert.equal(
    validatedServiceOrigin("https://service.example:8443/"),
    "https://service.example:8443",
  );
  for (const input of [
    null,
    {},
    "ifsoul://launch",
    "file:///tmp/app",
    "http://127.0.0.1:8788",
    "https://user:pass@service.example",
    "https://service.example/private",
    "https://service.example/#token",
    "https://service.example/?secret",
  ]) {
    assert.equal(validatedServiceOrigin(input), null);
  }
  assert.equal(isOrigin(appOrigin + "/app", appOrigin), true);
  assert.equal(isOrigin(appOrigin + "@other.example/app", appOrigin), false);
});

test("Desktop can use distinct explicit loopback ports", () => {
  assert.equal(desktopLoopbackOrigins({}).appOrigin, appOrigin);
  assert.deepEqual(
    desktopLoopbackOrigins({
      IFSOUL_DESKTOP_APP_PORT: "38142",
      IFSOUL_DESKTOP_COMPANION_PORT: "38143",
    }),
    {
      appOrigin: "http://127.0.0.1:38142",
      companionOrigin: "http://127.0.0.1:38143",
    },
  );
  assert.throws(() =>
    desktopLoopbackOrigins({ IFSOUL_DESKTOP_APP_PORT: "28811" }),
  );
  for (const value of [
    "0",
    "1023",
    "65536",
    "28788.0",
    "https://example.test",
    " 28788",
  ])
    assert.throws(() =>
      desktopLoopbackOrigins({ IFSOUL_DESKTOP_APP_PORT: value }),
    );
});
