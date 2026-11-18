// backend/src/services/speakable-text.ts
//
// Turn an agent answer (markdown, [Evidence N] citations) into plain text
// that sounds natural when spoken, capped to a character budget because
// ElevenLabs bills per character. Pure and deterministic: no LLM call, so
// speaking an answer costs no extra Gemini request, latency or quota.

/** `[Evidence 1]`, `[Source 3]`, `[warmly]`: any short bracket that is not a link. */
const BRACKET_TAG = /\s*\[[^[\]\n]{0,40}\](?!\()/g
/** `[text](url)` → `text`. */
const MARKDOWN_LINK = /\[([^[\]\n]*)\]\([^)\n]*\)/g
/** Leading `- `, `* `, `+ `, `• `, `1. ` or `1) ` on a list line. */
const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+/
const HEADING_MARKER = /^\s*#{1,6}\s+/
/** Underscore emphasis only — keeps identifiers like `page_count` intact. */
const UNDERSCORE_EMPHASIS = /(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu
const SENTENCE_END = /[.!?]$/
const ELLIPSIS = "…"

function stripInlineMarkdown(line: string): string {
  return line
    .replace(MARKDOWN_LINK, "$1")
    .replace(/\*+/g, "")
    .replace(UNDERSCORE_EMPHASIS, "")
    .replace(/`+/g, "")
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim()
}

/** Cut at the last sentence end within `maxChars`; else at the last word plus "…". */
function capAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text

  for (let i = maxChars - 1; i > 0; i--) {
    const char = text[i]
    const next = text[i + 1]
    const endsSentence = char === "." || char === "!" || char === "?"
    if (endsSentence && (next === undefined || /\s/.test(next))) {
      return text.slice(0, i + 1)
    }
  }

  const room = text.slice(0, maxChars - ELLIPSIS.length)
  const lastSpace = room.lastIndexOf(" ")
  const words = lastSpace > 0 ? room.slice(0, lastSpace) : room
  return `${words.replace(/[\s,;:–—-]+$/, "")}${ELLIPSIS}`
}

/**
 * Plain, speakable version of `answer`, at most `maxChars` long.
 * Returns "" when nothing speakable is left (the caller then skips TTS).
 */
export function toSpeakableText(answer: string, maxChars: number): string {
  // 1. Citation and audio-style tags (links are kept for step 2).
  const withoutTags = answer.replace(BRACKET_TAG, "")

  // 2 + 3. Markdown off, and every list item or heading becomes a sentence.
  const sentences: string[] = []
  for (const rawLine of withoutTags.split(/\r?\n/)) {
    const isListItem = LIST_MARKER.test(rawLine)
    const isHeading = HEADING_MARKER.test(rawLine)
    const body = rawLine.replace(LIST_MARKER, "").replace(HEADING_MARKER, "")
    const line = tidy(stripInlineMarkdown(body))
    if (line === "") continue
    // A plain prose line may run on into the next (e.g. "requires:"); list
    // items and headings always end as their own sentence.
    const needsStop = (isListItem || isHeading) && !SENTENCE_END.test(line)
    sentences.push(needsStop ? `${line.replace(/[,;:]$/, "")}.` : line)
  }

  // 4. Whitespace and spacing before punctuation.
  let text = tidy(sentences.join(" "))
  if (text === "" || !/[\p{L}\p{N}]/u.test(text)) return ""
  if (!SENTENCE_END.test(text) && !text.endsWith(ELLIPSIS)) text = `${text}.`

  // 5. Character budget, cut on a sentence boundary when possible.
  return capAtSentence(text, maxChars)
}
