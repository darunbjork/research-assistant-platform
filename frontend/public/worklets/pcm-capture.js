// frontend/public/worklets/pcm-capture.js
// AudioWorklet processor for the Day 4 mic capture (useVoiceCapture.ts).
//
// Served as a static same-origin module (/worklets/pcm-capture.js) rather
// than a blob: URL — Chrome gates AudioWorklet module loads under
// script-src, so a blob would require widening script-src to blob: for no
// benefit. Same-origin 'self' is already allowed by deploy/Caddyfile's CSP.
//
// Runs on the audio rendering thread: batches the 128-frame render quanta
// into 1024-sample Float32Array messages (~21 ms at 48 kHz, ~64 ms at
// 16 kHz). All silence-gating, resampling and PCM16 framing stays in
// useVoiceCapture.ts where it is typed and unit-tested.

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.batch = new Float32Array(1024)
    this.used = 0
  }

  process(inputs) {
    const channels = inputs[0]
    if (channels !== undefined && channels.length > 0) {
      const channel = channels[0]
      let offset = 0
      while (offset < channel.length) {
        const n = Math.min(this.batch.length - this.used, channel.length - offset)
        this.batch.set(channel.subarray(offset, offset + n), this.used)
        this.used += n
        offset += n
        if (this.used === this.batch.length) {
          this.port.postMessage(this.batch.slice())
          this.used = 0
        }
      }
    }
    return true
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor)
