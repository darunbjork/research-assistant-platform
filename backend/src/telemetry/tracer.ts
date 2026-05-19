/* eslint-disable no-console */
// backend/src/telemetry/tracer.ts

import { IncomingMessage } from "http"
import { NodeSDK } from "@opentelemetry/sdk-node"
import {
  SimpleSpanProcessor,
  ConsoleSpanExporter,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { trace, type Tracer } from "@opentelemetry/api"

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "research-assistant-backend"
const SERVICE_VERSION = process.env.SERVICE_VERSION ?? "1.0.0"

function buildSpanProcessor() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

  if (endpoint) {
    const exporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers: {},
    })
    return new BatchSpanProcessor(exporter, {
      maxQueueSize: 1024,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5000,
      exportTimeoutMillis: 30000,
    })
  }

  return new SimpleSpanProcessor(new ConsoleSpanExporter())
}

const sdk = new NodeSDK({
  spanProcessor: buildSpanProcessor(),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": {
        enabled: true,
        ignoreIncomingRequestHook: (req: IncomingMessage) => {
          const path = req.url ?? ""
          return path === "/health" || path === "/metrics" || path === "/ws/agent"
        },
      },
      "@opentelemetry/instrumentation-dns": { enabled: true },
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-express": { enabled: true },
    }),
  ],
})

sdk.start()

process.on("SIGTERM", () => {
  sdk
    .shutdown()
    .then(() => console.log("✅ OTel SDK shutdown complete"))
    .catch((err: Error | unknown) => console.error("❌ OTel SDK shutdown error:", err))
})

process.on("SIGINT", () => {
  sdk.shutdown().catch((err: Error | unknown) => console.error("❌ OTel SDK shutdown error:", err))
})

export function getTracer(name: string): Tracer {
  return trace.getTracer(`${SERVICE_NAME}/${name}`, SERVICE_VERSION)
}

export { sdk }
