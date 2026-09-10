import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { translate } from "./lib/i18n";
import "./styles.css";
import "./force-delete-window.css";

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
const ForceDeleteWindow = lazy(() =>
  import("./views/ForceDeleteWindow").then((module) => ({ default: module.ForceDeleteWindow }))
);

const mode = new URLSearchParams(window.location.search).get("mode");
if (mode === "force-delete") document.documentElement.dataset.utility = "force-delete";
const Root =
  mode === "quick-search"
    ? QuickSearchWindow
    : mode === "uninstall-restore"
      ? UninstallRestoreView
      : mode === "force-delete"
        ? ForceDeleteWindow
        : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<div className="bootstrap-loading" aria-label={`${translate("loading.page")} CDriveShiftAI`} />}>
      <Root />
    </Suspense>
  </StrictMode>
);
