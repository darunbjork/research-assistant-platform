// backend/src/__tests__/speakable-text.test.ts
//
// toSpeakableText: citations and markdown removed, lists spoken as
// sentences, and the per-answer character cap applied on a sentence boundary.

import { toSpeakableText } from "../services/speakable-text"

const LIMIT = 600

describe("toSpeakableText — real agent answers", () => {
  it.each([
    [
      "file types",
      "Based on the provided evidence, the upload accepts the following file types: PDF, TXT, MD, and CSV [Evidence 1].",
      "Based on the provided evidence, the upload accepts the following file types: PDF, TXT, MD, and CSV.",
    ],
    [
      "quantum ferret",
      'Based on the report, the "quantum ferret" is a marker that appears on page two (acting as a second marker so that cross-page retrieval can be checked) [Evidence 1, Evidence 2]. Additionally, the report notes that search finds the quantum ferret [Evidence 1].',
      'Based on the report, the "quantum ferret" is a marker that appears on page two (acting as a second marker so that cross-page retrieval can be checked). Additionally, the report notes that search finds the quantum ferret.',
    ],
    [
      "ingestion checklist",
      [
        "Based on the provided evidence, the ingestion checklist requires:",
        "- Upload accepts the PDF without a type or size warning [Evidence 1].",
        "- Extracted text comes from BOTH pages (pageCount = 2) [Evidence 1].",
        "- The document appears in the library list after processing [Evidence 1].",
        "- Search finds amber falcon and quantum ferret [Evidence 1].",
      ].join("\n"),
      "Based on the provided evidence, the ingestion checklist requires: Upload accepts the PDF without a type or size warning. Extracted text comes from BOTH pages (pageCount = 2). The document appears in the library list after processing. Search finds amber falcon and quantum ferret.",
    ],
  ])("%s", (_name, answer, expected) => {
    expect(toSpeakableText(answer, LIMIT)).toBe(expected)
  })
})

describe("toSpeakableText — cleanup rules", () => {
  it.each([
    ["multi-citation tag", "Two sources agree [Evidence 1, Evidence 2].", "Two sources agree."],
    ["source tag", "See the appendix [Source 3].", "See the appendix."],
    ["audio-style tag", "[warmly] Here is the answer.", "Here is the answer."],
    [
      "brackets longer than 40 characters are kept",
      "Keep [this bracket because it is far longer than forty characters] please.",
      "Keep [this bracket because it is far longer than forty characters] please.",
    ],
    [
      "mixed bullet list",
      "Steps:\n* first step\n+ second step!\n1. third step\n2) fourth step:",
      "Steps: first step. second step! third step. fourth step.",
    ],
    [
      "link keeps its text",
      "Read [the docs](https://example.com/docs) first.",
      "Read the docs first.",
    ],
    [
      "bold, italics, code and headings",
      "## Result\n**Bold** and *italic* and _under_ and `code` stay readable",
      "Result. Bold and italic and under and code stay readable.",
    ],
    ["identifiers keep underscores", "Set page_count to 2.", "Set page_count to 2."],
    ["only citations", "[Evidence 1] [Evidence 2, Evidence 3]", ""],
    ["empty answer", "", ""],
    ["punctuation only", "- .\n- ,", ""],
    [
      "non-ASCII survives",
      "Svaret är: **Göteborg** och Malmö [Evidence 1].",
      "Svaret är: Göteborg och Malmö.",
    ],
  ])("%s", (_name, answer, expected) => {
    expect(toSpeakableText(answer, LIMIT)).toBe(expected)
  })
})

describe("toSpeakableText — character cap", () => {
  it("cuts at the last sentence end before the limit", () => {
    const text = "First sentence here. Second sentence is longer than the rest."
    expect(toSpeakableText(text, 30)).toBe("First sentence here.")
  })

  it("keeps a sentence that ends exactly at the limit", () => {
    const text = "Exactly twenty chars. Then more words follow after it."
    const limit = "Exactly twenty chars.".length
    expect(toSpeakableText(text, limit)).toBe("Exactly twenty chars.")
  })

  it("does not treat a decimal point as a sentence end", () => {
    const text = "Version 3.5 is current and the rest of this sentence keeps going on."
    expect(toSpeakableText(text, 30)).toBe("Version 3.5 is current and…")
  })

  it("cuts at the last word and adds an ellipsis when there is no sentence end", () => {
    const result = toSpeakableText(
      "one two three four five six seven eight nine ten eleven twelve",
      20
    )
    expect(result).toBe("one two three four…")
    expect(result.length).toBeLessThanOrEqual(20)
  })

  it("never exceeds the limit, even for one long word", () => {
    const result = toSpeakableText("x".repeat(50), 10)
    expect(result).toBe(`${"x".repeat(9)}…`)
    expect(result).toHaveLength(10)
  })

  it("leaves text under the limit untouched", () => {
    expect(toSpeakableText("Short answer.", 600)).toBe("Short answer.")
  })
})
