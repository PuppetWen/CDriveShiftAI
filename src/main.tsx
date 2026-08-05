import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { translate } from "./lib/i18n";
import "./styles.css";

const QuickSearchWindow = lazy(() =>
  import("./views/QuickSearchWindow").then((module) => ({
    default: module.QuickSearchWindow
  }))
);
const UninstallRestoreView = lazy(() =>
  import("./views/UninstallRestoreView").then((module) => ({
    default: module.UninstallRestoreView
  }))
);

const mode = new URLSearchParams(window.location.search).get("mode");
const Root =
  mode === "quick-search"
    ? QuickSearchWindow
    : mode === "uninstall-restore"
      ? UninstallRestoreView
      : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<div className="bootstrap-loading" aria-label={`${translate("loading.page")} CDriveShiftAI`} />}>
      <Root />
    </Suspense>
  </StrictMode>
);
