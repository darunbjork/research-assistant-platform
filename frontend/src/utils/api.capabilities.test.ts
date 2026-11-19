// frontend/src/utils/api.capabilities.test.ts
// getServerCapabilities only ever returns two real booleans; anything else
// rejects, so a malformed answer can't switch voice on.

import { afterEach, describe, expect, it, vi } from "vitest";
import api, { getServerCapabilities } from "./api";

function answer(data: unknown): void {
  vi.spyOn(api, "get").mockResolvedValueOnce({ data });
}

describe("getServerCapabilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls GET /config and returns exactly the two voice flags", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValueOnce({
      data: { success: true, data: { voice: { stt: false, tts: true, extra: 1 } }, error: null },
    });

    await expect(getServerCapabilities()).resolves.toEqual({ voice: { stt: false, tts: true } });
    expect(get).toHaveBeenCalledWith("/config");
  });

  it.each([
    ["not successful", { success: false, data: null, error: "boom" }],
    ["no voice block", { success: true, data: {}, error: null }],
    ["a string flag", { success: true, data: { voice: { stt: "true", tts: true } }, error: null }],
    ["a missing flag", { success: true, data: { voice: { stt: true } }, error: null }],
  ])("rejects %s", async (_label, data) => {
    answer(data);
    await expect(getServerCapabilities()).rejects.toThrow("Unexpected server capabilities response");
  });
});
