import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../../apps/laboratory/src/App";
import { AppSidebar } from "../../apps/laboratory/src/components/AppSidebar";
import { SidebarProvider } from "../../apps/laboratory/src/components/ui/sidebar";
import {
  RuntimeAuthContext,
  type RuntimeAuth,
} from "../../apps/laboratory/src/lib/runtime-auth";
const auth: RuntimeAuth = {
  config: { mode: "local", auth: "local", laboratory: true },
  signedIn: true,
  userId: "local",
  userName: "Local workspace",
  signIn() {},
  async signOut() {},
};
function sidebar(value: RuntimeAuth) {
  return renderToStaticMarkup(
    createElement(
      RuntimeAuthContext.Provider,
      { value },
      createElement(
        SidebarProvider,
        null,
        createElement(AppSidebar, { section: "chat", onNavigate() {} }),
      ),
    ),
  );
}
function signIn(value: RuntimeAuth) {
  return renderToStaticMarkup(
    createElement(
      RuntimeAuthContext.Provider,
      { value: { ...value, signedIn: false } },
      createElement(App),
    ),
  );
}
test("standalone App navigation contains no host playground route", () => {
  for (const value of [
    auth,
    {
      ...auth,
      config: { mode: "cloud" as const, auth: "injected", laboratory: false },
    },
  ]) {
    assert.doesNotMatch(sidebar(value), /href="\/demo"|Playground/);
    assert.doesNotMatch(signIn(value), /playground|href="\/demo"/);
  }
  assert.match(sidebar(auth), /Laboratory/);
});
test("hosting adapter opts both signed-in and signed-out navigation into its playground", () => {
  const value = { ...auth, playgroundHref: "/host-playground" };
  assert.match(sidebar(value), /href="\/host-playground"/);
  assert.match(signIn(value), /href="\/host-playground"/);
});
