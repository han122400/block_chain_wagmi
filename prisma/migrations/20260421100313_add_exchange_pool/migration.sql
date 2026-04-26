-- CreateTable
CREATE TABLE "exchange_pool" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "total_liquidity_eth" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_issued_phb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_pool_pkey" PRIMARY KEY ("id")
);
