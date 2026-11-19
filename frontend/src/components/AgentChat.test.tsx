// frontend/src/components/AgentChat.test.tsx
// Spoken-answer controls in AgentChat: the 🔊 toggle (saved, sent as
// set_speak via the hook), ⏹ Stop, and barge-in when the mic or a new
// typed question interrupts an answer being read aloud. The three hooks
// are doubles that record the order of calls. Also: the voice controls follow
// the server's capability (GET /api/v1/config) and fail closed.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentChat from "./AgentChat";
import { resetServerCapabilitiesCache } from "../hooks/useServerCapabilities";
import type { ServerCapabilities } from "../types";

const calls: string[] = [];
let speaking = false;
let ttsError: string | null = null;
const wsOptions: Array<{ speakEnabled?: boolean }> = [];

vi.mock("../hooks/useTtsPlayer", () => ({
  useTtsPlayer: () => ({
    isSpeaking: speaking,
    prime: () => calls.push("player.prime"),
    stop: () => calls.push("player.stop"),
    start: vi.fn(),
    frame: vi.fn(),
    done: vi.fn(),
  }),
}));

vi.mock("../hooks/useVoiceCapture", () => ({
  useVoiceCapture: () => ({
    isCapturing: false,
    startCapture: () => {
      calls.push("voice.startCapture");
      return Promise.resolve();
    },
    stopCapture: () => calls.push("voice.stopCapture"),
  }),
}));

vi.mock("../hooks/useAgentWebSocket", () => ({
  useAgentWebSocket: (options: { speakEnabled?: boolean }) => {
    wsOptions.push(options);
    return {
      connectionState: "authenticated",
      agentStatus: "idle",
      currentMessage: "ResearchBot ready",
      steps: [],
      citations: [],
      result: null,
      finalAnswer: "",
      qualityScore: null,
      error: null,
      voiceError: null,
      transcriptFinal: null,
      ttsError,
      isRunning: false,
      startQuery: (query: string) => calls.push(`ws.startQuery:${query}`),
      disconnect: vi.fn(),
      voiceStart: () => calls.push("ws.voiceStart"),
      voiceEnd: () => calls.push("ws.voiceEnd"),
      sendVoiceFrame: vi.fn(),
      bargeIn: () => calls.push("ws.bargeIn"),
    };
  },
}));

// What GET /api/v1/config answers; each test can replace it.
let capabilitiesResponse: () => Promise<ServerCapabilities>;
const voiceOn = (): Promise<ServerCapabilities> =>
  Promise.resolve({ voice: { stt: true, tts: true } });

vi.mock("../utils/api", () => ({
  queryAgent: vi.fn(),
  getServerCapabilities: () => capabilitiesResponse(),
}));

const VOICE_INPUT_OFF = "Voice input is turned off on this server";
const SPOKEN_ANSWERS_OFF = "Spoken answers are turned off on this server";

/** Render and wait until the voice capability has loaded (voice on). */
async function renderReady(): Promise<ReturnType<typeof render>> {
  const view = render(<AgentChat />);
  await screen.findByRole("button", { name: "Start microphone" });
  return view;
}

describe("AgentChat — spoken answers", () => {
  beforeEach(() => {
    calls.length = 0;
    wsOptions.length = 0;
    speaking = false;
    ttsError = null;
    localStorage.clear();
    resetServerCapabilitiesCache();
    capabilitiesResponse = voiceOn;
    // jsdom has no layout: scrollIntoView is missing.
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(cleanup);

  it("speaks answers by default and turning the toggle off is saved and sent", async () => {
    await renderReady();
    expect(wsOptions.at(-1)?.speakEnabled).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: /speak answers: on/i }));
    expect(wsOptions.at(-1)?.speakEnabled).toBe(false);
    expect(localStorage.getItem("researchbot.speakAnswers")).toBe("off");
    expect(calls).toContain("player.stop");
  });

  it("restores a saved 'off' preference", async () => {
    localStorage.setItem("researchbot.speakAnswers", "off");
    await renderReady();
    expect(wsOptions.at(-1)?.speakEnabled).toBe(false);
    expect(screen.getByRole("switch", { name: /speak answers: off/i })).toBeTruthy();
  });

  it("still works when storage is blocked", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await renderReady();
    expect(wsOptions.at(-1)?.speakEnabled).toBe(true);
    getItem.mockRestore();
  });

  it("shows ⏹ Stop only while speaking; it stops playback and barges in", async () => {
    const { rerender } = await renderReady();
    expect(screen.queryByRole("button", { name: "Stop speaking" })).toBeNull();

    speaking = true;
    rerender(<AgentChat />);
    fireEvent.click(screen.getByRole("button", { name: "Stop speaking" }));
    expect(calls).toEqual(["player.stop", "ws.bargeIn"]);
  });

  it("pressing the mic while speaking stops playback and barges in before voice_start", async () => {
    speaking = true;
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Start microphone" }));

    expect(calls.indexOf("player.stop")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("ws.bargeIn")).toBeGreaterThan(calls.indexOf("player.stop"));
    expect(calls.indexOf("ws.voiceStart")).toBeGreaterThan(calls.indexOf("ws.bargeIn"));
  });

  it("pressing the mic when nothing is playing does not barge in", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Start microphone" }));
    expect(calls).not.toContain("ws.bargeIn");
    expect(calls).toContain("ws.voiceStart");
  });

  it("a new typed question stops the answer being spoken", async () => {
    speaking = true;
    await renderReady();
    fireEvent.change(screen.getByPlaceholderText(/ask a question/i), {
      target: { value: "Next question?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(calls.indexOf("player.stop")).toBeLessThan(calls.indexOf("ws.startQuery:Next question?"));
  });

  it("shows a TTS failure as a small note", async () => {
    ttsError = "Daily spoken-answer limit reached.";
    await renderReady();
    expect(screen.getByRole("note").textContent).toContain("Daily spoken-answer limit reached.");
  });
});

describe("AgentChat — voice follows the server's capability", () => {
  beforeEach(() => {
    calls.length = 0;
    wsOptions.length = 0;
    speaking = false;
    ttsError = null;
    localStorage.clear();
    resetServerCapabilitiesCache();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(cleanup);

  /** The mic button, whichever label it currently has. */
  function micButton(): HTMLButtonElement {
    return screen.getByRole("button", { name: /microphone|voice input/i }) as HTMLButtonElement;
  }

  it("stt=false: the mic is disabled, labelled and has a tooltip", async () => {
    capabilitiesResponse = () => Promise.resolve({ voice: { stt: false, tts: true } });
    render(<AgentChat />);
    // The answer has arrived once the speak toggle turns on (tts=true).
    await screen.findByRole("switch", { name: /speak answers: on/i });

    const mic = screen.getByRole("button", { name: VOICE_INPUT_OFF }) as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
    expect(mic.getAttribute("title")).toBe(VOICE_INPUT_OFF);
    // The wrapper carries the hover tooltip (a disabled button gets no pointer events).
    expect(mic.parentElement?.getAttribute("title")).toBe(VOICE_INPUT_OFF);

    fireEvent.click(mic);
    expect(calls).not.toContain("ws.voiceStart");
    expect(calls).not.toContain("voice.startCapture");
  });

  it("stt=true: the mic is enabled and starts a voice turn", async () => {
    capabilitiesResponse = voiceOn;
    render(<AgentChat />);

    const mic = (await screen.findByRole("button", {
      name: "Start microphone",
    })) as HTMLButtonElement;
    expect(mic.disabled).toBe(false);
    expect(mic.parentElement?.getAttribute("title")).toBeNull();

    fireEvent.click(mic);
    expect(calls).toContain("ws.voiceStart");
    expect(calls).toContain("voice.startCapture");
  });

  it("tts=false: the speak toggle is disabled and the server is never asked to speak", async () => {
    capabilitiesResponse = () => Promise.resolve({ voice: { stt: true, tts: false } });
    render(<AgentChat />);
    await screen.findByRole("button", { name: "Start microphone" });

    const toggle = screen.getByRole("switch", { name: SPOKEN_ANSWERS_OFF }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("title")).toBe(SPOKEN_ANSWERS_OFF);
    expect(toggle.textContent).toContain("unavailable");
    // The saved preference defaults to on, yet set_speak is never requested.
    expect(wsOptions.every((options) => options.speakEnabled === false)).toBe(true);

    fireEvent.click(toggle);
    expect(localStorage.getItem("researchbot.speakAnswers")).toBeNull();
    expect(calls).not.toContain("player.prime");
  });

  it("fails closed while the capability is loading", () => {
    capabilitiesResponse = () => new Promise<ServerCapabilities>(() => {});
    render(<AgentChat />);

    expect(micButton().disabled).toBe(true);
    expect(micButton().getAttribute("aria-label")).toBe(VOICE_INPUT_OFF);
    expect(screen.getByRole("switch", { name: SPOKEN_ANSWERS_OFF })).toBeTruthy();
    expect(wsOptions.at(-1)?.speakEnabled).toBe(false);
  });

  it("fails closed when the capability request fails", async () => {
    let rejected = false;
    capabilitiesResponse = () => {
      rejected = true;
      return Promise.reject(new Error("network down"));
    };
    render(<AgentChat />);
    await waitFor(() => expect(rejected).toBe(true));
    // Let the rejection settle, then check that nothing turned on.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(micButton().disabled).toBe(true);
    expect(micButton().getAttribute("aria-label")).toBe(VOICE_INPUT_OFF);
    expect(screen.getByRole("switch", { name: SPOKEN_ANSWERS_OFF })).toBeTruthy();
    expect(wsOptions.at(-1)?.speakEnabled).toBe(false);
  });
});
