import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { validateProjectVersion } from "./version-policy.mjs";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(workspace, process.argv[2] || "release-ready");
await validateProjectVersion(workspace);

async function sha512(candidate) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha512");
    const stream = createReadStream(candidate);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

async function describe(name) {
  const candidate = path.join(output, name);
  const details = await stat(candidate);
  return {
    name,
    size: details.size,
    sha512: await sha512(candidate)
  };
}

const manifest = {
  schemaVersion: 1,
  version: packageJson.version,
  assets: {
    installer: await describe("CDriveShiftAI-x64.exe"),
    portable: await describe("CDriveShiftAI-x64-portable.exe")
  }
};

await writeFile(
  path.join(output, "update-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
console.log(JSON.stringify(manifest, null, 2));
