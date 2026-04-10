CREATE TABLE "SafetyTemplate" (
  "key" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SafetyTemplate_pkey" PRIMARY KEY ("key")
);
