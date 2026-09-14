-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "cachedTokens" INTEGER,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewResult" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "indexInFile" INTEGER NOT NULL,
    "sentiment" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "themes" TEXT[],
    "complaints" TEXT[],
    "quotedEvidence" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawModelResponse" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "rawResponse" TEXT NOT NULL,
    "validationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawModelResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Job_storageKey_key" ON "Job"("storageKey");

-- CreateIndex
CREATE INDEX "Job_userId_idx" ON "Job"("userId");

-- CreateIndex
CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewResult_jobId_indexInFile_key" ON "ReviewResult"("jobId", "indexInFile");

-- CreateIndex
CREATE UNIQUE INDEX "RawModelResponse_jobId_attemptNumber_key" ON "RawModelResponse"("jobId", "attemptNumber");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewResult" ADD CONSTRAINT "ReviewResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawModelResponse" ADD CONSTRAINT "RawModelResponse_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint
-- Not a native Postgres enum: adding a status later is a constraint swap
-- (DROP CONSTRAINT / ADD CONSTRAINT), not a type migration.
ALTER TABLE "Job" ADD CONSTRAINT "Job_status_check"
  CHECK ("status" IN ('pending', 'processing', 'done', 'failed'));

-- CheckConstraint
-- Same String + CHECK pattern as Job.status, for consistency across the
-- schema, rather than a native enum for this table alone.
ALTER TABLE "ReviewResult" ADD CONSTRAINT "ReviewResult_sentiment_check"
  CHECK ("sentiment" IN ('positive', 'negative', 'mixed'));

-- CheckConstraint
ALTER TABLE "ReviewResult" ADD CONSTRAINT "ReviewResult_rating_check"
  CHECK ("rating" BETWEEN 1 AND 5);
