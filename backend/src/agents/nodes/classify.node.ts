// backend/src/agents/nodes/classify.node.ts
// Classifies the user's query into a TaskType.
// The agent router uses this to decide which tools are most likely needed.
//
// WHY CLASSIFY?
// "What is the capital of France?" → general (no tools needed, just say IDK)
// "What does our report say about revenue?" → rag_search
// "Calculate 15% of $4.2M" → math (calculator)
// "What happened in the news today?" → web_search
//
// A correct classification speeds up the agent by starting with
// the most relevant tool instead of reasoning from scratch.
// A wrong classification is fine — the ReAct loop corrects itself.

import type { TaskType } from "../../types/agent.types"

interface ClassificationRule {
  keywords: string[]
  taskType: TaskType
}

const CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    // Math/calculation queries
    keywords: [
      "calculate",
      "compute",
      "percent",
      "%",
      "percentage",
      "how much",
      "how many",
      "total",
      "sum",
      "average",
      "multiply",
      "divide",
      "ratio",
      "growth rate",
    ],
    taskType: "math",
  },
  {
    // Current events / web queries
    keywords: [
      "latest",
      "current",
      "today",
      "recent",
      "news",
      "right now",
      "this week",
      "this year",
      "2025",
      "2026",
    ],
    taskType: "web_search",
  },
  {
    // Document queries — most common for a RAG system
    keywords: [
      "document",
      "report",
      "file",
      "says",
      "according to",
      "what does",
      "find",
      "search",
      "tell me about",
      "summarize",
      "summary",
      "explain",
      "describe",
    ],
    taskType: "rag_search",
  },
]

export function classifyQuery(query: string): TaskType {
  const lowerQuery = query.toLowerCase()

  // Score each task type by how many keywords match
  const scores: Record<TaskType, number> = {
    math: 0,
    web_search: 0,
    rag_search: 0,
    general: 0,
  }

  for (const rule of CLASSIFICATION_RULES) {
    for (const keyword of rule.keywords) {
      if (lowerQuery.includes(keyword)) {
        scores[rule.taskType]++
      }
    }
  }

  // Find the task type with the highest score
  const maxScore = Math.max(...Object.values(scores))

  if (maxScore === 0) {
    // No keywords matched — default to RAG search for a document platform
    return "rag_search"
  }

  // Return the task type with the highest keyword match count
  const winner = (Object.entries(scores) as Array<[TaskType, number]>).find(
    ([, score]) => score === maxScore
  )

  return winner?.[0] ?? "rag_search"
}
