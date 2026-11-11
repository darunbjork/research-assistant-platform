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

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
const NODE_ENV = process.env.NODE_ENV

function buildSpanProcessor() {
  if (OTLP_ENDPOINT) {
    const exporter = new OTLPTraceExporter({
      url: `${OTLP_ENDPOINT}/v1/traces`,
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

// When does the SDK start at all? (D8/D22)
// - development: never — today's behaviour, spans are no-ops there.
// - production without an OTLP endpoint: never — console spans in
//   production are noise nobody can ingest.
// - otherwise: yes. An endpoint always exports OTLP; without one, only
//   test keeps today's console exporter.
const shouldStartSdk =
  NODE_ENV !== "development" && (Boolean(OTLP_ENDPOINT) || NODE_ENV !== "production")

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

if (shouldStartSdk) {
  sdk.start()
}

/**
 * Flush and stop the SDK. The app's graceful-shutdown path calls this
 * (task 5.5) instead of this module owning SIGTERM/SIGINT handlers.
 * Resolves immediately when the SDK was never started.
 */
export function shutdownTracing(): Promise<void> {
  return shouldStartSdk ? sdk.shutdown() : Promise.resolve()
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(`${SERVICE_NAME}/${name}`, SERVICE_VERSION)
}

export { sdk }
