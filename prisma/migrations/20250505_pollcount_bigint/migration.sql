-- RedefineTables
-- Change pollCount from Int to BigInt, and fix column order (nextPollAt after completedAt)
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PendingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sailResponseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestBody" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "apiType" TEXT NOT NULL DEFAULT 'chat-completions',
    "completionWindow" TEXT NOT NULL,
    "responseBody" TEXT,
    "errorBody" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "sailBodyHash" TEXT,
    "completedAt" DATETIME,
    "pollCount" BIGINT NOT NULL DEFAULT 0,
    "nextPollAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_PendingJob" ("apiType", "completedAt", "completionWindow", "createdAt", "errorBody", "id", "model", "nextPollAt", "pollCount", "requestBody", "responseBody", "sailBodyHash", "sailResponseId", "status", "updatedAt") SELECT "apiType", "completedAt", "completionWindow", "createdAt", "errorBody", "id", "model", "nextPollAt", "pollCount", "requestBody", "responseBody", "sailBodyHash", "sailResponseId", "status", "updatedAt" FROM "PendingJob";
DROP TABLE "PendingJob";
ALTER TABLE "new_PendingJob" RENAME TO "PendingJob";
CREATE UNIQUE INDEX "PendingJob_sailResponseId_key" ON "PendingJob"("sailResponseId");
CREATE INDEX "PendingJob_status_nextPollAt_idx" ON "PendingJob"("status", "nextPollAt");
CREATE INDEX "PendingJob_sailBodyHash_idx" ON "PendingJob"("sailBodyHash");
CREATE INDEX "PendingJob_createdAt_idx" ON "PendingJob"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
