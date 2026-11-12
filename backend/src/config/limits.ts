// backend/src/config/limits.ts
// Shared size limits. One source of truth so the Express body-parser config
// and the user-facing error message can never drift apart (F7 follow-up,
// Day 0.5): changing the limit here updates both.

/** Max JSON request body in bytes: 2 MB (D10: documents up to 500,000 chars). */
export const JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024

/**
 * Human-readable label derived from the byte value ("2 MB") for error
 * messages — same constant as the parser, so the message cannot lie.
 */
export const JSON_BODY_LIMIT_LABEL = `${JSON_BODY_LIMIT_BYTES / (1024 * 1024)} MB`
