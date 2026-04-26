-- =============================================================================
-- Migration: 001_init_phb_system
-- Description: PHB 거래소 내부 코인 시스템 초기화
--   - users: 지갑 주소별 PHB 잔액 관리
--   - positions: 오프체인 레버리지 포지션 기록
--   - deposit_logs: ETH 충전 기록 (이중 입금 방지)
-- =============================================================================

-- ─── users 테이블 ─────────────────────────────────────────────────────────────
CREATE TABLE "users" (
    "id"          TEXT        NOT NULL,
    "address"     TEXT        NOT NULL,       -- MetaMask 지갑 주소 (소문자)
    "phb_balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- users.address 유니크 인덱스
CREATE UNIQUE INDEX "users_address_key" ON "users"("address");

-- ─── positions 테이블 ─────────────────────────────────────────────────────────
CREATE TABLE "positions" (
    "id"           TEXT             NOT NULL,
    "user_address" TEXT             NOT NULL,
    "margin_phb"   DOUBLE PRECISION NOT NULL,  -- 증거금 (PHB 단위)
    "entry_price"  DOUBLE PRECISION NOT NULL,  -- 진입가
    "leverage"     INTEGER          NOT NULL,  -- 레버리지 배율
    "is_long"      BOOLEAN          NOT NULL,  -- true=롱, false=숏
    "is_open"      BOOLEAN          NOT NULL DEFAULT true,
    "opened_at"    TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at"    TIMESTAMP(3),
    "exit_price"   DOUBLE PRECISION,
    "pnl_phb"      DOUBLE PRECISION,           -- 손익 (PHB)
    "is_profit"    BOOLEAN,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- positions → users 외래 키
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_address_fkey"
    FOREIGN KEY ("user_address") REFERENCES "users"("address")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 활성 포지션 조회 인덱스
CREATE INDEX "positions_user_address_is_open_idx"
    ON "positions"("user_address", "is_open");

-- ─── deposit_logs 테이블 ──────────────────────────────────────────────────────
CREATE TABLE "deposit_logs" (
    "id"           TEXT             NOT NULL,
    "user_address" TEXT             NOT NULL,
    "tx_hash"      TEXT             NOT NULL,   -- Sepolia 트랜잭션 해시 (이중 입금 방지)
    "eth_amount"   DOUBLE PRECISION NOT NULL,   -- ETH 단위
    "phb_amount"   DOUBLE PRECISION NOT NULL,   -- 지급된 PHB
    "created_at"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_logs_pkey" PRIMARY KEY ("id")
);

-- tx_hash 유니크 (같은 TX로 중복 충전 불가)
CREATE UNIQUE INDEX "deposit_logs_tx_hash_key" ON "deposit_logs"("tx_hash");

-- deposit_logs → users 외래 키
ALTER TABLE "deposit_logs" ADD CONSTRAINT "deposit_logs_user_address_fkey"
    FOREIGN KEY ("user_address") REFERENCES "users"("address")
    ON DELETE RESTRICT ON UPDATE CASCADE;
