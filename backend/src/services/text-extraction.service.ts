// backend/src/services/text-extraction.service.ts
//
// Task 4.1 (D17): turn an uploaded file into ingestible text.
//   - PDF   → pdf-parse v2 (PDFParse class), magic-byte checked, page-capped
//   - .txt/.md/.csv → UTF-8 decode, NUL-byte rejection (binary sniffing)
//   - anything else → ValidationError
// The returned pageCount is null for plain-text files (unknown / not paginated).

import { PDFParse } from "pdf-parse"
import path from "path"
import { ValidationError } from "../middleware/error.middleware"

export interface ExtractedText {
  text: string
  pageCount: number | null
}

const MAX_PDF_PAGES = 200
const MIN_PDF_TEXT_CHARS = 50
const PDF_MAGIC = "%PDF-"
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv"])
const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/comma-separated-values",
])

/**
 * Extract ingestible text from an uploaded buffer.
 * Throws ValidationError (400) for anything that must not be ingested.
 */
export async function extractText(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<ExtractedText> {
  const ext = path.extname(filename ?? "").toLowerCase()
  const mime = (mimeType ?? "").toLowerCase()
  const looksLikePdf =
    buffer.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC ||
    ext === ".pdf" ||
    mime === "application/pdf"

  if (looksLikePdf) {
    return extractPdf(buffer)
  }

  if (TEXT_EXTENSIONS.has(ext) || TEXT_MIME_TYPES.has(mime)) {
    return extractPlainText(buffer)
  }

  throw new ValidationError("Unsupported file type — PDF, TXT, MD, or CSV only")
}

async function extractPdf(buffer: Buffer): Promise<ExtractedText> {
  if (buffer.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) {
    throw new ValidationError("File is not a valid PDF (missing %PDF- header)")
  }

  const parser = new PDFParse({ data: buffer })
  try {
    let pageCount: number
    let text: string
    try {
      const info = await parser.getInfo()
      pageCount = info.total
      if (pageCount > MAX_PDF_PAGES) {
        throw new ValidationError(`PDF exceeds ${MAX_PDF_PAGES} pages (found ${pageCount})`)
      }
      const result = await parser.getText()
      text = result.text ?? ""
    } catch (error: unknown) {
      if (error instanceof ValidationError) {
        throw error
      }
      throw new ValidationError("File could not be parsed as PDF")
    }

    if (text.trim().length < MIN_PDF_TEXT_CHARS) {
      throw new ValidationError("No extractable text — scanned PDFs are not supported")
    }

    return { text, pageCount }
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

function extractPlainText(buffer: Buffer): ExtractedText {
  if (buffer.includes(0)) {
    throw new ValidationError(
      "File contains binary data (NUL bytes) — only UTF-8 text files are supported"
    )
  }
  return { text: buffer.toString("utf8"), pageCount: null }
}
