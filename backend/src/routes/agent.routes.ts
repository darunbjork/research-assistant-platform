// backend/src/routes/agent.routes.ts

import { Router } from "express"
import { AgentController } from "../controllers/agent.controller"
import { authMiddleware } from "../middleware/auth.middleware"

const router = Router()
const controller = new AgentController()

router.use(authMiddleware)

/**
 * @swagger
 * /agent/chat:
 *   post:
 *     summary: Send a message to the ResearchBot agent
 *     description: |
 *       Runs the autonomous ReAct agent loop:
 *       1. Classifies the query type
 *       2. Reasons about which tool to call
 *       3. Executes the tool (rag_search, calculator, etc.)
 *       4. Observes the result
 *       5. Repeats until sufficient information gathered (max 5 iterations)
 *       6. Synthesises a grounded final answer with citations
 *
 *       More powerful than /rag/query for complex multi-step questions.
 *     tags: [Agent]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query]
 *             properties:
 *               query:
 *                 type: string
 *                 example: "What is the total revenue from Q3 and Q4 combined?"
 *     responses:
 *       200:
 *         description: Agent result with steps, answer, and citations
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/AgentChatResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/chat", controller.chat)

export default router
