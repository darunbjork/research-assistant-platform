import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AppPage from "./AppPage";
import { listDocuments } from "../utils/api";
import type { DocumentSummary } from "../types";

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../utils/api", () => ({ listDocuments: vi.fn() }));
vi.mock("../components/AgentChat", () => ({ default: () => null }));
vi.mock("../components/DocumentUpload", () => ({
  default: ({ onSuccess }: { onSuccess: () => void }) => (
    <button onClick={onSuccess}>Complete ingestion</button>
  ),
}));
vi.mock("../components/DocumentList", () => ({
  default: ({
    documents,
    isLoading,
  }: {
    documents: DocumentSummary[];
    isLoading: boolean;
  }) => (
    <div>
      {isLoading
        ? "Loading documents"
        : documents.length === 0
          ? "No documents"
          : documents.map((doc) => (
              <p
                key={doc.id}
              >{`${doc.name}: ${doc.sizeBytes} bytes (${doc.mimeType})`}</p>
            ))}
    </div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listDocuments).mockResolvedValue([]);
});
afterEach(cleanup);

it("refetches real metadata after ingestion without inventing a zero-byte document", async () => {
  render(<AppPage />);
  await screen.findByText("No documents");
  let finishRefresh!: (documents: DocumentSummary[]) => void;
  vi.mocked(listDocuments).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Complete ingestion" }));
  expect(listDocuments).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Loading documents")).toBeTruthy();
  expect(screen.queryByText(/0 bytes/)).toBeNull();
  await act(async () =>
    finishRefresh([
      {
        id: "doc-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2840,
        userId: "user-1",
        chunkCount: 3,
        createdAt: "2026-11-15",
        updatedAt: "2026-11-15",
      },
    ]),
  );
  expect(
    screen.getByText("report.pdf: 2840 bytes (application/pdf)"),
  ).toBeTruthy();
});

it("does not display static claims that external services are healthy", async () => {
  render(<AppPage />);
  await screen.findByText("No documents");
  expect(screen.queryByText("Gemini API")).toBeNull();
  expect(screen.queryByText("Redis cache")).toBeNull();
});
