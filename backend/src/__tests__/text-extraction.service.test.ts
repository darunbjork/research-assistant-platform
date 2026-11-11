// backend/src/__tests__/text-extraction.service.test.ts
//
// Task 4.1 (D17): extractText() contract —
//   PDF (magic bytes, ≤200 pages, ≥50 chars of text), plain-text files
//   (.txt/.md/.csv with NUL-byte rejection), everything else rejected.
// Fixtures are generated at runtime with pdf-lib (dev dependency); Gemini and
// all external services are irrelevant here — this is pure buffer handling.

import { PDFDocument, StandardFonts } from "pdf-lib"
import { extractText } from "../services/text-extraction.service"
import { ValidationError } from "../middleware/error.middleware"

async function makePdf(lines: string[], pageCount = 1): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792])
    let y = 720
    for (const line of lines) {
      page.drawText(line, { x: 50, y, size: 12, font })
      y -= 16
    }
  }
  return Buffer.from(await doc.save())
}

const SAMPLE_LINES = [
  "Quarterly research summary for the deploy readiness review.",
  "The retrieval pipeline achieves strong recall on the eval set.",
  "Embeddings are produced by a Gemini model and stored in pgvector.",
]

describe("extractText()", () => {
  describe("PDF files", () => {
    it("extracts text and reports the page count", async () => {
      const pdf = await makePdf(SAMPLE_LINES)

      const result = await extractText(pdf, "application/pdf", "report.pdf")

      expect(result.pageCount).toBe(1)
      expect(result.text).toContain("Quarterly research summary")
      expect(result.text.trim().length).toBeGreaterThanOrEqual(50)
    })

    it("rejects PDFs over 200 pages", async () => {
      const pdf = await makePdf(["placeholder"], 201)

      await expect(extractText(pdf, "application/pdf", "huge.pdf")).rejects.toThrow(
        "PDF exceeds 200 pages (found 201)"
      )
    })

    it("rejects PDFs with no extractable text (scanned)", async () => {
      const pdf = await makePdf([], 1) // blank page, no text operators

      await expect(extractText(pdf, "application/pdf", "scan.pdf")).rejects.toThrow(
        "No extractable text — scanned PDFs are not supported"
      )
    })

    it("rejects a .pdf whose bytes are not a PDF (wrong magic)", async () => {
      const fake = Buffer.from("NOT-A-REAL-PDF-FILE-AT-ALL-XXXXXXXXXXXX")

      await expect(extractText(fake, "application/pdf", "fake.pdf")).rejects.toThrow(
        "File is not a valid PDF (missing %PDF- header)"
      )
    })

    it("rejects a corrupt file that carries the %PDF- magic", async () => {
      const corrupt = Buffer.concat([Buffer.from("%PDF-"), Buffer.from("garbage garbage")])

      await expect(extractText(corrupt, "application/pdf", "corrupt.pdf")).rejects.toThrow(
        "File could not be parsed as PDF"
      )
    })

    it("throws ValidationError (400) for every rejection", async () => {
      const fake = Buffer.from("NOT-A-REAL-PDF")
      await expect(extractText(fake, "application/pdf", "fake.pdf")).rejects.toBeInstanceOf(
        ValidationError
      )
    })
  })

  describe("plain-text files", () => {
    it("decodes .txt as UTF-8 with pageCount null", async () => {
      const result = await extractText(
        Buffer.from("hello research world"),
        "text/plain",
        "notes.txt"
      )

      expect(result.text).toBe("hello research world")
      expect(result.pageCount).toBeNull()
    })

    it("accepts .md and .csv", async () => {
      const md = await extractText(Buffer.from("# Title\n\nBody text"), "text/markdown", "doc.md")
      const csv = await extractText(Buffer.from("a,b,c\n1,2,3"), "text/csv", "table.csv")

      expect(md.text).toContain("# Title")
      expect(csv.text).toContain("a,b,c")
      expect(md.pageCount).toBeNull()
      expect(csv.pageCount).toBeNull()
    })

    it("rejects files containing NUL bytes (binary sniffing)", async () => {
      const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08])

      await expect(extractText(binary, "text/plain", "payload.txt")).rejects.toThrow(
        "File contains binary data (NUL bytes)"
      )
    })
  })

  describe("unsupported types", () => {
    it("rejects an .exe", async () => {
      const exe = Buffer.from("MZ\x90\x00 this is a windows executable")

      await expect(extractText(exe, "application/octet-stream", "setup.exe")).rejects.toThrow(
        "Unsupported file type — PDF, TXT, MD, or CSV only"
      )
    })
  })
})
