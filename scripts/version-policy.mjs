import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// This policy applies only to newly published CDriveShiftAI versions. Historical
// versions and third-party dependencies continue to use their original syntax.
export function assertReleaseVersion(version) {
  if (typeof version !== "string" || !/^[0-9]\.[0-9]\.[0-9]$/.test(version)) {
    throw new Error(`Invalid CDriveShiftAI release version: ${String(version)}. Each of the three components must be a single digit (0-9).`);
  }
  return version;
}

export function nextReleaseVersion(version) {
  assertReleaseVersion(version);
  const current = Number(version.replaceAll(".", ""));
  if (current === 999) throw new Error("Version 9.9.9 exhausts the current release numbering policy.");
  return String(current + 1).padStart(3, "0").split("").join(".");
}

export function validateVersionMetadata(packageJson, lock, releaseNotes) {
  const version = assertReleaseVersion(packageJson.version);
  if (lock.version !== version || lock.packages?.[""]?.version !== version) {
    throw new Error("package.json and package-lock.json root versions must match.");
  }
  for (const name of ["bundledReleaseNotes", "bundledReleaseNotesEnglish"]) {
    const match = releaseNotes.match(new RegExp(`export const ${name}\\s*:[^=]+=\\s*\\{[^{}]*?["']?version["']?\\s*:\\s*["']([^"']+)["']`));
    if (match?.[1] !== version) throw new Error(`${name} must declare the current version ${version}.`);
  }
  return version;
}

export async function validateProjectVersion(root = workspace) {
  const [packageText, lockText, releaseNotes] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "package-lock.json"), "utf8"),
    readFile(path.join(root, "src/lib/releaseNotes.ts"), "utf8")
  ]);
  return validateVersionMetadata(JSON.parse(packageText), JSON.parse(lockText), releaseNotes);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args[0] !== "--next" || args.length > 2)) {
      throw new Error("Usage: node scripts/version-policy.mjs [--next [current-version]]");
    }
    const version = args[1] ?? await validateProjectVersion();
    console.log(args[0] === "--next" ? nextReleaseVersion(version) : `Release version verified: ${version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
