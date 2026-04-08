-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'IN_USE', 'CHARGING', 'MAINTENANCE');

-- AlterTable
ALTER TABLE "Vehicle"
  ALTER COLUMN "driverId" DROP NOT NULL,
  ADD COLUMN "status" "VehicleStatus" NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN "batteryCapacityKwh" DOUBLE PRECISION,
  ADD COLUMN "batteryLevel" INTEGER,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill updatedAt for existing rows
UPDATE "Vehicle" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "updatedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_plateNumber_key" ON "Vehicle"("plateNumber");
