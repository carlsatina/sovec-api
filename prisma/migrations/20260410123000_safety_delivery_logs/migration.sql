CREATE TABLE "SafetyDeliveryLog" (
  "id" TEXT NOT NULL,
  "incidentId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL,
  "lastError" TEXT,
  "payload" JSONB,
  "deliveredAt" TIMESTAMP(3),
  "deadLetteredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SafetyDeliveryLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SafetyDeliveryLog_incidentId_createdAt_idx" ON "SafetyDeliveryLog"("incidentId", "createdAt");
CREATE INDEX "SafetyDeliveryLog_status_createdAt_idx" ON "SafetyDeliveryLog"("status", "createdAt");
