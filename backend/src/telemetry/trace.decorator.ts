import { getTracer } from "./tracer"
import { withSpan } from "./spans"
import type { Tracer } from "@opentelemetry/api"

// ── Trace Decorator Factory ────────────────────────────────────────────────
export function Trace(
  spanName: string,
  attributes: Record<string, string | number | boolean> = {}
) {
  return function (
    _target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value as (...args: unknown[]) => Promise<unknown>

    descriptor.value = async function (...args: unknown[]): Promise<unknown> {
      const tracer: Tracer = getTracer(propertyKey)
      return withSpan(tracer, spanName, async () => originalMethod.apply(this, args), attributes)
    }

    return descriptor
  }
}
