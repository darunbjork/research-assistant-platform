/* eslint-disable no-console */
// backend/src/scripts/run-coverage-report.ts
// Prints a human-readable coverage summary after running jest --coverage.
// Usage: npm run test:coverage && npx ts-node src/scripts/run-coverage-report.ts

import fs from "fs"
import path from "path"

interface CoverageData {
  total: { lines: { pct: number }; functions: { pct: number }; branches: { pct: number } }
}

async function main(): Promise<void> {
  const coveragePath = path.join(process.cwd(), "coverage", "coverage-summary.json")

  if (!fs.existsSync(coveragePath)) {
    console.log("❌ No coverage report found. Run: npm run test:coverage first.")
    process.exit(1)
  }

  const raw = fs.readFileSync(coveragePath, "utf-8")
  const coverage = JSON.parse(raw) as Record<string, CoverageData>
  const total = coverage["total"]

  if (!total) {
    console.log("❌ Coverage summary missing 'total' key.")
    process.exit(1)
  }

  console.log("\n" + "=".repeat(55))
  console.log("COVERAGE REPORT")
  console.log("=".repeat(55))

  const dims = [
    { name: "Lines", pct: total.total.lines.pct },
    { name: "Functions", pct: total.total.functions.pct },
    { name: "Branches", pct: total.total.branches.pct },
  ]

  dims.forEach(dim => {
    const bar = "█".repeat(Math.round(dim.pct / 10)) + "░".repeat(10 - Math.round(dim.pct / 10))
    const status = dim.pct >= 80 ? "✅" : dim.pct >= 70 ? "⚠️ " : "❌"
    console.log(`${status} ${dim.name.padEnd(12)}: [${bar}] ${dim.pct.toFixed(1)}%`)
  })

  const overall = (total.total.lines.pct + total.total.functions.pct) / 2
  console.log("─".repeat(55))

  if (overall >= 80) {
    console.log(`✅ Coverage target MET (${overall.toFixed(1)}% average)`)
  } else {
    console.log(`❌ Coverage below 80% target (${overall.toFixed(1)}% average)`)
    console.log("   Run: npm run test:coverage to see which files need tests")
  }

  console.log("=".repeat(55) + "\n")
}

main().catch(console.error)
