// load-tests/scripts/setup-test-user.ts
// Creates the test user used by Artillery load tests.
// Run once before load testing.
//
// Usage: npx ts-node load-tests/scripts/setup-test-user.ts

import dotenv from "dotenv"
dotenv.config({ path: "../backend/.env" })

const BASE_URL   = process.env.API_URL       ?? "http://localhost:3001"
const TEST_EMAIL = process.env.TEST_USER_EMAIL    ?? "loadtest@example.com"
const TEST_PASS  = process.env.TEST_USER_PASSWORD ?? "loadtest123!"

async function setupTestUser(): Promise<void> {
  console.log("=".repeat(55))
  console.log("ARTILLERY TEST USER SETUP")
  console.log("=".repeat(55))
  console.log()
  console.log(`Target:   ${BASE_URL}`)
  console.log(`Email:    ${TEST_EMAIL}`)
  console.log()

  // ── Step 1: Try to register ───────────────────────────────────────────
  console.log("1. Registering test user...")
  const registerResp = await fetch(`${BASE_URL}/api/v1/auth/register`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS })
  })

  const registerData = await registerResp.json() as {
    success: boolean
    error?:  string
  }

  if (registerResp.ok && registerData.success) {
    console.log("   ✅ Test user registered successfully.")
  } else if (registerData.error?.toLowerCase().includes("already")) {
    console.log("   ℹ️  Test user already exists — continuing.")
  } else {
    console.error("   ❌ Registration failed:", registerData.error)
    process.exit(1)
  }

  // ── Step 2: Login and verify token ────────────────────────────────────
  console.log("2. Verifying login...")
  const loginResp = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS })
  })

  const loginData = await loginResp.json() as {
    success: boolean
    data?: { tokens: { accessToken: string }; user: { id: string } }
    error?:  string
  }

  if (!loginResp.ok || !loginData.success || !loginData.data) {
    console.error("   ❌ Login failed:", loginData.error)
    process.exit(1)
  }

  const token  = loginData.data.tokens.accessToken
  const userId = loginData.data.user.id

  console.log("   ✅ Login successful.")
  console.log(`   User ID: ${userId}`)

  // ── Step 3: Verify the token works on a protected endpoint ────────────
  console.log("3. Verifying token on protected endpoint...")
  const meResp = await fetch(`${BASE_URL}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  if (!meResp.ok) {
    console.error("   ❌ Token verification failed.")
    process.exit(1)
  }

  console.log("   ✅ Token works.")

  // ── Step 4: Ingest a test document ────────────────────────────────────
  console.log("4. Ingesting test document for RAG queries...")
  const ingestResp = await fetch(`${BASE_URL}/api/v1/documents/ingest`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${token}`
    },
    body: JSON.stringify({
      name:     "load-test-document.txt",
      content:  LOAD_TEST_DOCUMENT,
      mimeType: "text/plain"
    })
  })

  const ingestData = await ingestResp.json() as {
    success: boolean
    data?:   { jobId: string }
    error?:  string
  }

  if (!ingestData.success || !ingestData.data) {
    console.log("   ⚠️  Ingestion failed (may already exist):", ingestData.error)
  } else {
    const jobId = ingestData.data.jobId
    console.log(`   ✅ Ingestion queued: jobId=${jobId}`)
    console.log("   Waiting for ingestion to complete...")

    // Poll for completion
    let attempts = 0
    while (attempts < 30) {
      await new Promise(r => setTimeout(r, 2000))
      attempts++

      const statusResp = await fetch(
        `${BASE_URL}/api/v1/documents/jobs/${jobId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const statusData = await statusResp.json() as {
        data?: { status: string; progress: number }
      }

      const status   = statusData.data?.status ?? "unknown"
      const progress = statusData.data?.progress ?? 0
      process.stdout.write(`   Status: ${status} | Progress: ${progress}%  `)

      if (status === "completed") {
        console.log("\n   ✅ Test document ingested.")
        break
      }
      if (status === "failed") {
        console.log("\n   ⚠️  Ingestion failed — tests will still run but RAG quality may be low.")
        break
      }
    }
  }

  console.log()
  console.log("=".repeat(55))
  console.log("SETUP COMPLETE — Ready for load testing")
  console.log("=".repeat(55))
  console.log()
  console.log("Add to your .env:")
  console.log(`  TEST_USER_EMAIL=${TEST_EMAIL}`)
  console.log(`  TEST_USER_PASSWORD=${TEST_PASS}`)
  console.log()
  console.log("Run load tests:")
  console.log("  npm run loadtest:baseline")
  console.log("  npm run loadtest:ramp")
  console.log("  npm run loadtest:cache")
  console.log("  npm run loadtest:spike")
  console.log("  npm run loadtest:sustained")
}

// ── Test document content ─────────────────────────────────────────────────
const LOAD_TEST_DOCUMENT = `
Machine Learning — A Comprehensive Overview

Machine learning (ML) is a subset of artificial intelligence that enables
systems to learn and improve from experience without being explicitly programmed.

Core Concepts:

1. Supervised Learning
Supervised learning uses labelled training data to train models. The model
learns to map inputs to outputs based on example input-output pairs.
Common algorithms include linear regression, decision trees, and neural networks.

2. Unsupervised Learning
Unsupervised learning finds patterns in data without labelled examples.
Clustering (K-means, DBSCAN) and dimensionality reduction (PCA, t-SNE)
are key techniques used to discover structure in unlabelled datasets.

3. Reinforcement Learning
Reinforcement learning trains agents to make decisions by rewarding
desirable behaviours. Applications include game playing, robotics,
and autonomous vehicle navigation.

4. Deep Learning
Deep learning uses neural networks with many layers (hence "deep") to learn
hierarchical representations. Transformers, CNNs, and RNNs are architectures
that have revolutionised NLP, computer vision, and speech recognition.

5. Retrieval-Augmented Generation (RAG)
RAG combines retrieval systems with generative models. Documents are chunked
and embedded into vector space. At query time, relevant chunks are retrieved
and passed as context to a language model for grounded answer generation.

Performance Metrics:
- Accuracy: proportion of correct predictions
- Precision: true positives / (true positives + false positives)
- Recall:    true positives / (true positives + false negatives)
- F1 Score:  harmonic mean of precision and recall
- BLEU:      measures text generation quality
- ROUGE:     evaluates summarisation quality

Challenges in Machine Learning:
1. Data quality and quantity requirements
2. Overfitting — model memorises training data, fails on new data
3. Computational cost of training large models
4. Interpretability — understanding model decisions
5. Distribution shift — real-world data differs from training data
6. Fairness and bias in automated decision-making

Production Considerations:
Deploying ML models requires monitoring for data drift, model degradation,
and performance regression. A/B testing, shadow deployments, and canary
releases help manage production risk. MLOps practices automate the
model training, validation, and deployment pipeline.
`

setupTestUser().catch((error: unknown) => {
  console.error("Setup failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
