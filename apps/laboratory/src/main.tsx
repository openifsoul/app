import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RuntimeBootstrap } from "./lib/runtime-auth";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RuntimeBootstrap>
      <App />
    </RuntimeBootstrap>
  </StrictMode>,
);
