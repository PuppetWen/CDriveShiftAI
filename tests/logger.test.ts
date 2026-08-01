import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureLogger, logger } from "../electron/logger";

const fixtureRoot = path.join(
  process.cwd(),
  ".cdriveshiftai-data",
  "test-temp",
  "logger-tests"
);

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("structured application logger", () => {
  it("redacts credentials, search text and file content", async () => {
    await mkdir(fixtureRoot, { recursive: true });
    configureLogger(fixtureRoot);
    logger.error("privacy.fixture", {
      apiKey: "super-secret-key",
      authorization: "Bearer private",
      query: "private search",
      content: "private file body",
      harmless: "visible"
    });
    const logDirectory = path.join(fixtureRoot, "logs");
    const [logName] = await readdir(logDirectory);
    const logged = await readFile(path.join(logDirectory, logName), "utf8");
    expect(logged).toContain("visible");
    expect(logged).not.toContain("super-secret-key");
    expect(logged).not.toContain("private search");
    expect(logged).not.toContain("private file body");
    expect(logged).toContain("[REDACTED]");
  });
});
