import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => process.cwd()
  }
}));

import { SearchService } from "../electron/search";

describe("search index change bridge", () => {
  it("forwards coalesced native index mutations to the active search UI", () => {
    const onIndexChanged = vi.fn();
    const service = new SearchService(
      () => undefined,
      () => undefined,
      onIndexChanged,
      () => undefined,
      { button: "disabled", holdMs: 3_000 }
    );
    const internals = service as unknown as { handleLine(line: string): void };

    internals.handleLine(
      JSON.stringify({
        event: "indexChanged",
        changedCount: 7,
        generation: 12,
        contentScopes: ["E:\\docs"]
      })
    );

    expect(onIndexChanged).toHaveBeenCalledOnce();
    expect(onIndexChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        changedCount: 7,
        generation: 12,
        contentScopes: ["E:\\docs"]
      })
    );
  });
});
