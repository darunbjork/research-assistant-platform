import type { PrismaClient, Document } from "@prisma/client"
import { NotFoundError } from "../middleware/error.middleware"
import { logRagEvent } from "../utils/logger"
import type { DocumentUploadRequest } from "../types"
export interface DocumentSummary {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  userId: string
  createdAt: Date
  updatedAt: Date
  chunkCount?: number
}

export interface DocumentListOptions {
  userId: string
  limit?: number
  offset?: number
}

export class DocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: DocumentUploadRequest, userId: string): Promise<Document> {
    const start = Date.now()

    const document = await this.prisma.document.create({
      data: {
        name: data.name,
        content: data.content,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        userId,
      },
    })

    logRagEvent("ingest", "Document created in database", {
      service: "DocumentRepository",
      documentId: document.id,
      durationMs: Date.now() - start,
    })

    return document
  }

  async findById(documentId: string): Promise<Document> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
    })

    if (document === null) {
      throw new NotFoundError(`Document ${documentId}`)
    }

    return document
  }

  async findByIdForUser(documentId: string, userId: string): Promise<Document> {
    const document = await this.prisma.document.findFirst({
      where: {
        id: documentId,
        userId,
      },
    })

    if (document === null) {
      throw new NotFoundError("Document")
    }

    return document
  }

  async listForUser(options: DocumentListOptions): Promise<DocumentSummary[]> {
    const limit = options.limit ?? 20
    const offset = options.offset ?? 0

    const documents = await this.prisma.document.findMany({
      where: { userId: options.userId },
      select: {
        id: true,
        name: true,
        mimeType: true,
        sizeBytes: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { chunks: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    })

    return documents.map(doc => ({
      id: doc.id,
      name: doc.name,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      chunkCount: doc._count.chunks,
    }))
  }

  async countForUser(userId: string): Promise<number> {
    return this.prisma.document.count({
      where: { userId },
    })
  }

  async deleteForUser(documentId: string, userId: string): Promise<void> {
    await this.findByIdForUser(documentId, userId)

    await this.prisma.document.delete({
      where: { id: documentId },
    })

    logRagEvent("ingest", "Document deleted", {
      service: "DocumentRepository",
      documentId,
    })
  }
}
