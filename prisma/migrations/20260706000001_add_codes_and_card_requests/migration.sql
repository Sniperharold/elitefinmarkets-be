-- AlterTable: add verification code fields to users
ALTER TABLE "users" ADD COLUMN "cotCode" TEXT;
ALTER TABLE "users" ADD COLUMN "imtCode" TEXT;
ALTER TABLE "users" ADD COLUMN "tacCode" TEXT;

-- CreateTable: card_requests
CREATE TABLE "card_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "deliveryAddress" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "zipCode" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_requests_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "card_requests" ADD CONSTRAINT "card_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
