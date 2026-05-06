-- CreateTable
CREATE TABLE "ModelMeta" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "contextSize" INTEGER,
    "description" TEXT,
    "source" TEXT,
    "supportsImage" BOOLEAN NOT NULL DEFAULT false,
    "reasoning" BOOLEAN NOT NULL DEFAULT false,
    "thinkingLevelMap" TEXT,
    "researchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ModelPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelMetaId" TEXT NOT NULL,
    "completionWindow" TEXT NOT NULL,
    "inputPerMTok" REAL NOT NULL,
    "cachedInputPerMTok" REAL,
    "outputPerMTok" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ModelPrice_modelMetaId_fkey" FOREIGN KEY ("modelMetaId") REFERENCES "ModelMeta" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SamplingPreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelMetaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "params" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SamplingPreset_modelMetaId_fkey" FOREIGN KEY ("modelMetaId") REFERENCES "ModelMeta" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PendingJob" (
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
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelMeta_modelId_key" ON "ModelMeta"("modelId");

-- CreateIndex
CREATE INDEX "ModelPrice_modelMetaId_idx" ON "ModelPrice"("modelMetaId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelPrice_modelMetaId_completionWindow_key" ON "ModelPrice"("modelMetaId", "completionWindow");

-- CreateIndex
CREATE INDEX "SamplingPreset_modelMetaId_idx" ON "SamplingPreset"("modelMetaId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingJob_sailResponseId_key" ON "PendingJob"("sailResponseId");

-- CreateIndex
CREATE INDEX "PendingJob_status_nextPollAt_idx" ON "PendingJob"("status", "nextPollAt");

-- CreateIndex
CREATE INDEX "PendingJob_sailBodyHash_idx" ON "PendingJob"("sailBodyHash");

-- CreateIndex
CREATE INDEX "PendingJob_createdAt_idx" ON "PendingJob"("createdAt");
