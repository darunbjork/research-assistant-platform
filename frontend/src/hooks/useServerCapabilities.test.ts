// frontend/src/hooks/useServerCapabilities.test.ts
// One request per page load, shared by every caller; fail closed until the
// server answers and after a failure (retried on the next mount).

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerCapabilities } from "../types";

const mockGet = vi.fn<() => Promise<ServerCapabilities>>();
vi.mock("../utils/api", () => ({ getServerCapabilities: () => mockGet() }));

import { resetServerCapabilitiesCache, useServerCapabilities, VOICE_OFF } from "./useServerCapabilities";

describe("useServerCapabilities", () => {
  beforeEach(() => {
    mockGet.mockReset();
    resetServerCapabilitiesCache();
  });
  afterEach(cleanup);

  it("starts with voice off, then reports the server's answer", async () => {
    mockGet.mockResolvedValue({ voice: { stt: true, tts: false } });
    const { result } = renderHook(() => useServerCapabilities());

    expect(result.current).toEqual({ capabilities: VOICE_OFF, loaded: false });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.capabilities).toEqual({ voice: { stt: true, tts: false } });
  });

  it("fetches once and shares the answer between callers", async () => {
    mockGet.mockResolvedValue({ voice: { stt: true, tts: true } });
    const first = renderHook(() => useServerCapabilities());
    const second = renderHook(() => useServerCapabilities());

    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    await waitFor(() => expect(second.result.current.loaded).toBe(true));
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("stays off after a failure and retries on the next mount", async () => {
    mockGet.mockRejectedValueOnce(new Error("network down"));
    const failed = renderHook(() => useServerCapabilities());
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failed.result.current).toEqual({ capabilities: VOICE_OFF, loaded: false });

    mockGet.mockResolvedValueOnce({ voice: { stt: true, tts: true } });
    const retried = renderHook(() => useServerCapabilities());
    await waitFor(() => expect(retried.result.current.loaded).toBe(true));
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
