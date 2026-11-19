// frontend/src/hooks/useServerCapabilities.ts
//
// What the server can serve (GET /api/v1/config), fetched ONCE per page
// load and shared by every caller. FAIL CLOSED: until the answer arrives,
// and if the request fails, voice reads as unavailable. A control is never
// shown as working when the server might refuse it.

import { useEffect, useState } from "react";
import { getServerCapabilities } from "../utils/api";
import type { ServerCapabilities } from "../types";

export const VOICE_OFF: ServerCapabilities = { voice: { stt: false, tts: false } };

export interface ServerCapabilitiesState {
  capabilities: ServerCapabilities;
  /** True once the server answered (false while loading or after a failure). */
  loaded: boolean;
}

let cached: Promise<ServerCapabilities> | null = null;

/** One request per page load; a failed request is retried on next mount. */
function loadOnce(): Promise<ServerCapabilities> {
  if (cached === null) {
    cached = getServerCapabilities().catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

/** Test hook: forget the cached answer. */
export function resetServerCapabilitiesCache(): void {
  cached = null;
}

export function useServerCapabilities(): ServerCapabilitiesState {
  const [state, setState] = useState<ServerCapabilitiesState>({
    capabilities: VOICE_OFF,
    loaded: false,
  });

  useEffect(() => {
    let active = true;
    loadOnce()
      .then((capabilities) => {
        if (active) setState({ capabilities, loaded: true });
      })
      .catch(() => {
        // Fail closed: keep VOICE_OFF.
        if (active) setState({ capabilities: VOICE_OFF, loaded: false });
      });
    return () => {
      active = false;
    };
  }, []);

  return state;
}
