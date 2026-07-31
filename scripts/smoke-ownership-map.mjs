import { scanOwnershipMap } from "../dist-electron/analyzer.js";

const result = await scanOwnershipMap("C:\\");
if (!result.entries.length) throw new Error("Ownership map returned no directories");
if (!result.entries.some((entry) => entry.path.toLocaleLowerCase() === "c:\\windows")) {
  throw new Error("Ownership map did not include the Windows system directory");
}
if (
  !result.entries.some(
    (entry) => entry.zone === "program-files" && entry.category === "application"
  )
) {
  throw new Error("Ownership map did not classify any Program Files application directory");
}

const counts = result.entries.reduce((output, entry) => {
  output[entry.category] = (output[entry.category] ?? 0) + 1;
  return output;
}, {});
const crossDriveOwners = result.entries.filter((entry) => {
  const installLocation = entry.owner?.installLocation;
  return (
    installLocation &&
    /^[a-z]:\\/i.test(installLocation) &&
    installLocation.slice(0, 2).toLocaleLowerCase() !== result.drive.slice(0, 2).toLocaleLowerCase()
  );
});

console.log(
  JSON.stringify(
    {
      drive: result.drive,
      entries: result.entries.length,
      installedApplications: result.installedApplications,
      durationMs: Math.round(result.durationMs),
      categories: counts,
      crossDriveOwners: crossDriveOwners.length,
      crossDriveSamples: crossDriveOwners.slice(0, 5).map((entry) => ({
        path: entry.path,
        app: entry.owner.appName,
        installLocation: entry.owner.installLocation
      })),
      scanErrors: result.scanErrors.length,
      result: "ok"
    },
    null,
    2
  )
);
