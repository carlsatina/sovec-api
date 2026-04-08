-- CreateTable
CREATE TABLE "FareConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "baseFare" DOUBLE PRECISION NOT NULL DEFAULT 55,
    "perKmRate" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "perMinuteRate" DOUBLE PRECISION NOT NULL DEFAULT 2.8,
    "minimumFare" DOUBLE PRECISION NOT NULL DEFAULT 55,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FareConfig_pkey" PRIMARY KEY ("id")
);

-- Seed singleton pricing row
INSERT INTO "FareConfig" ("id", "baseFare", "perKmRate", "perMinuteRate", "minimumFare", "currency", "updatedAt")
VALUES ('default', 55, 15, 2.8, 55, 'PHP', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
