// frontend/src/components/SuggestedQueries.tsx
// Shows example queries to help users get started.
// Displayed in the empty state when no documents are uploaded,
// and as quick-action chips after upload.

interface Props {
  onSelect:      (query: string) => void
  hasDocuments:  boolean
}

const DOCUMENT_QUERIES = [
  "What are the main topics covered in the document?",
  "Summarise the key findings",
  "What conclusions does the document reach?",
  "What are the most important numbers mentioned?"
]

const AGENT_DEMO_QUERIES = [
  "What is 15% of the first number mentioned in the document?",
  "Compare the different approaches described",
  "What problem does the document address?"
]

export default function SuggestedQueries({ onSelect, hasDocuments }: Props) {
  if (!hasDocuments) {
    return (
      <div className="py-4 text-center">
        <p className="text-xs italic text-slate-400">
          Upload a document to unlock ResearchBot
        </p>
      </div>
    )
  }

  return (
    <div className="px-5 pb-3">
      <p className="mb-2 text-xs font-medium tracking-wide uppercase text-slate-400">
        Try asking:
      </p>
      <div className="flex flex-wrap gap-1.5">
        {[...DOCUMENT_QUERIES, ...AGENT_DEMO_QUERIES].slice(0, 4).map(query => (
          <button
            key={query}
            onClick={() => onSelect(query)}
            className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs rounded-lg transition-colors text-left"
          >
            {query}
          </button>
        ))}
      </div>
    </div>
  )
}