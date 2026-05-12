import type Bull from "bull"
import { redis } from "../utils/redis"
import { createIngestionQueue } from "./ingestion.queue"
import type { IngestionJobData } from "./ingestion.queue"

let _queue: Bull.Queue<IngestionJobData> | null = null

export function getIngestionQueue(): Bull.Queue<IngestionJobData> {
  if (!_queue) {
    _queue = createIngestionQueue(redis)
  }
  return _queue
}

export { getJobStatus } from "./ingestion.queue"
export type { IngestionJobData, IngestionJobResult, JobStatus } from "./ingestion.queue"
