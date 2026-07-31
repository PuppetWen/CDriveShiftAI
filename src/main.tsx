import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { QuickSearchWindow } from "./views/QuickSearchWindow";
import { UninstallRestoreView } from "./views/UninstallRestoreView";
import "./styles.css";

const mode = new URLSearchParams(window.location.search).get("mode");
const Root =
  mode === "quick-search"
    ? QuickSearchWindow
    : mode === "uninstall-restore"
      ? UninstallRestoreView
      : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
