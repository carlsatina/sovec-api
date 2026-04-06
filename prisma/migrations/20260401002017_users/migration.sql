-- AlterTable
ALTER TABLE "DriverApplication" ADD COLUMN     "address" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "experienceYears" INTEGER,
ADD COLUMN     "fullName" TEXT,
ADD COLUMN     "interviewAt" TIMESTAMP(3),
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "preferredArea" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DriverDocument" ALTER COLUMN "status" SET DEFAULT 'PENDING';
