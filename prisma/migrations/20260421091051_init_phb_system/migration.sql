-- DropIndex
DROP INDEX "positions_user_address_is_open_idx";

-- AlterTable
ALTER TABLE "price_candles" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "price_state" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "updated_at" DROP DEFAULT;
