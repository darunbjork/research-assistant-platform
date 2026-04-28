export interface ApiResult<TData> {
  success: boolean
  data: TData | null
  error: string | null
  meta?: ResponseMeta
}

export interface ResponseMeta {
  page?: number
  limit?: number
  total?: number
  durationMs?: number
}

// * Use this in controllers for successful responses
export function ok<TData>(data: TData, meta?: ResponseMeta): ApiResult<TData> {
  return { success: true, data, error: null, meta }
}

// * Use this in controllers for error responses
export function fail<TData>(error: string): ApiResult<TData> {
  return { success: false, data: null, error }
}
