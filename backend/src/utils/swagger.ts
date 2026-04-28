// Generates the OpenAPI specification from JSDoc comments in route files.
// swaggerSpec is the JSON object that describes your entire API.
// It is served as interactive docs at /api/docs and as raw JSON at /api/docs.json

import swaggerJsdoc from "swagger-jsdoc"
import type { Options } from "swagger-jsdoc"

const options: Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Research Assistant Platform API",
      version: "1.0.0",
      description: `
## RAG + AI Agent API

A production-grade Retrieval-Augmented Generation platform.

### How Authentication Works
1. **Register** or **Login** to receive an \`accessToken\` and \`refreshToken\`

2. Copy the \`accessToken\`
3. Click **Authorize** (top right) and paste: \`Bearer YOUR_ACCESS_TOKEN\`
4. All protected endpoints now work

### Token Lifetimes
- **Access token**: 1 hour (development) / 15 minutes (production)
- **Refresh token**: 7 days — use \`POST /auth/refresh\` to get new tokens

### Response Envelope
Every response follows this shape:
\`\`\`json
{ "success": true, "data": { ... }, "error": null }
{ "success": false, "data": null, "error": "What went wrong" }
\`\`\`
      `,
      contact: {
        name: "API Support",
        url: "https://github.com/darunbjork/research-assistant-platform",
      },
    },
    servers: [
      {
        url: "http://localhost:3001/api/v1",
        description: "Development server",
      },
    ],
    // ── Reusable Components ────────────────────────────────────────────
    // Define these once. Reference them with $ref across all route docs.
    // This prevents copy-pasting the same schema in 10 different places.
    components: {
      // Security scheme — tells Swagger how to send the JWT token
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Paste your accessToken here. Get it from /auth/login or /auth/register.",
        },
      },
      // Reusable response schemas
      schemas: {
        // The envelope every response is wrapped in
        ApiResult: {
          type: "object",
          properties: {
            success: {
              type: "boolean",
              description: "true = operation succeeded, false = operation failed",
            },
            data: {
              description: "The response payload — null when success is false",
            },
            error: {
              type: "string",
              nullable: true,
              description: "Human-readable error message — null when success is true",
            },
          },
        },
        // Auth schemas
        PublicUser: {
          type: "object",
          properties: {
            id: { type: "string", example: "clxxxxxxxxxxxxxxxx" },
            email: { type: "string", example: "user@example.com" },
            role: {
              type: "string",
              enum: ["GUEST", "USER", "ADMIN"],
              example: "USER",
            },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        AuthTokens: {
          type: "object",
          properties: {
            accessToken: {
              type: "string",
              description: "Short-lived JWT — include in Authorization: Bearer header",
            },
            refreshToken: {
              type: "string",
              description: "Long-lived JWT — use to get a new access token",
            },
          },
        },
        AuthResponse: {
          type: "object",
          properties: {
            tokens: { $ref: "#/components/schemas/AuthTokens" },
            user: { $ref: "#/components/schemas/PublicUser" },
          },
        },
        // Error response
        ErrorResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: false },
            data: { nullable: true, example: null },
            error: { type: "string", example: "What went wrong" },
          },
        },
        // Document schemas (used starting Day 6)
        Document: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string", example: "Q3-Report.pdf" },
            mimeType: { type: "string", example: "application/pdf" },
            sizeBytes: { type: "integer", example: 204800 },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        // Citation schema (used starting Day 11)
        Citation: {
          type: "object",
          properties: {
            chunkId: { type: "string" },
            documentId: { type: "string" },
            documentName: { type: "string", example: "Q3-Report.pdf" },
            pageNumber: { type: "integer", nullable: true },
            excerpt: { type: "string", description: "First 200 chars of the chunk" },
            relevanceScore: { type: "number", minimum: 0, maximum: 1, example: 0.87 },
          },
        },
        // Agent response schema (used starting Day 12)
        AgentChatResponse: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            finalAnswer: { type: "string" },
            citations: {
              type: "array",
              items: { $ref: "#/components/schemas/Citation" },
            },
            iterationCount: { type: "integer", example: 2 },
            status: {
              type: "string",
              enum: ["idle", "thinking", "searching", "generating", "done", "error"],
            },
          },
        },
      },
      // Reusable response objects — use these in route docs
      responses: {
        Unauthorized: {
          description: "Missing or invalid JWT token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
              example: { success: false, data: null, error: "No token provided" },
            },
          },
        },
        NotFound: {
          description: "The requested resource does not exist",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        ValidationError: {
          description: "Request body failed validation",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
              example: { success: false, data: null, error: "email must be a valid email address" },
            },
          },
        },
        InternalError: {
          description: "Unexpected server error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  // Tell swagger-jsdoc which files contain JSDoc API comments.
  // It scans these files for @swagger annotations.
  apis: ["./src/routes/*.ts"],
}

export const swaggerSpec = swaggerJsdoc(options)
