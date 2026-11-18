// frontend/src/components/AgentChat.test.tsx
// Spoken-answer controls in AgentChat: the 🔊 toggle (saved, sent as
// set_speak via the hook), ⏹ Stop, and barge-in when the mic or a new
// typed question interrupts an answer being read aloud. The three hooks
// are doubles that record the order of calls.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentChat from "./AgentChat";

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

vi.mock("../utils/api", () => ({ queryAgent: vi.fn() }));

describe("AgentChat — spoken answers", () => {
  beforeEach(() => {
    calls.length = 0;
    wsOptions.length = 0;
    speaking = false;
    ttsError = null;
    localStorage.clear();
    // jsdom has no layout: scrollIntoView is missing.
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(cleanup);

  it("speaks answers by default and turning the toggle off is saved and sent", () => {
    render(<AgentChat />);
    expect(wsOptions.at(-1)?.speakEnabled).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: /speak answers: on/i }));
    expect(wsOptions.at(-1)?.speakEnabled).toBe(false);
    expect(localStorage.getItem("researchbot.speakAnswers")).toBe("off");
    expect(calls).toContain("player.stop");
  });

  it("restores a saved 'off' preference", () => {
    localStorage.setItem("researchbot.speakAnswers", "off");
    render(<AgentChat />);
    expect(wsOptions.at(-1)?.speakEnabled).toBe(false);
    expect(screen.getByRole("switch", { name: /speak answers: off/i })).toBeTruthy();
  });

  it("still works when storage is blocked", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<AgentChat />);
    expect(wsOptions.at(-1)?.speakEnabled).toBe(true);
    getItem.mockRestore();
  });

  it("shows ⏹ Stop only while speaking; it stops playback and barges in", () => {
    const { rerender } = render(<AgentChat />);
    expect(screen.queryByRole("button", { name: "Stop speaking" })).toBeNull();

    speaking = true;
    rerender(<AgentChat />);
    fireEvent.click(screen.getByRole("button", { name: "Stop speaking" }));
    expect(calls).toEqual(["player.stop", "ws.bargeIn"]);
  });

  it("pressing the mic while speaking stops playback and barges in before voice_start", () => {
    speaking = true;
    render(<AgentChat />);
    fireEvent.click(screen.getByRole("button", { name: "Start microphone" }));

    expect(calls.indexOf("player.stop")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("ws.bargeIn")).toBeGreaterThan(calls.indexOf("player.stop"));
    expect(calls.indexOf("ws.voiceStart")).toBeGreaterThan(calls.indexOf("ws.bargeIn"));
  });

  it("pressing the mic when nothing is playing does not barge in", () => {
    render(<AgentChat />);
    fireEvent.click(screen.getByRole("button", { name: "Start microphone" }));
    expect(calls).not.toContain("ws.bargeIn");
    expect(calls).toContain("ws.voiceStart");
  });

  it("a new typed question stops the answer being spoken", () => {
    speaking = true;
    render(<AgentChat />);
    fireEvent.change(screen.getByPlaceholderText(/ask a question/i), {
      target: { value: "Next question?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(calls.indexOf("player.stop")).toBeLessThan(calls.indexOf("ws.startQuery:Next question?"));
  });

  it("shows a TTS failure as a small note", () => {
    ttsError = "Daily spoken-answer limit reached.";
    render(<AgentChat />);
    expect(screen.getByRole("note").textContent).toContain("Daily spoken-answer limit reached.");
  });
});
