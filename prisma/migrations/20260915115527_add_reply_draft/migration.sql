-- CreateTable
CREATE TABLE "ReplyDraft" (
    "id" TEXT NOT NULL,
    "reviewResultId" TEXT NOT NULL,
    "replyText" TEXT NOT NULL,
    "rawResponse" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL,
    "completionTokens" INTEGER NOT NULL,
    "cachedTokens" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplyDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReplyDraft_reviewResultId_idx" ON "ReplyDraft"("reviewResultId");

-- AddForeignKey
ALTER TABLE "ReplyDraft" ADD CONSTRAINT "ReplyDraft_reviewResultId_fkey" FOREIGN KEY ("reviewResultId") REFERENCES "ReviewResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;
