-- =============================================================================
-- Migration: 002_add_shared_price_chart
-- Description: 모든 사용자가 동일한 차트를 보기 위한 공유 가격 데이터 테이블
--   - price_candles: 서버가 생성한 캔들 데이터 (5틱 = 1캔들)
--   - price_state:   가격 엔진 싱글톤 상태 (현재가, 틱, 모멘텀)
-- =============================================================================

-- ─── price_candles 테이블 ─────────────────────────────────────────────────────
CREATE TABLE "price_candles" (
    "id"           SERIAL           NOT NULL,
    "candle_index" INTEGER          NOT NULL,   -- 캔들 순번 (unique)
    "label"        TEXT             NOT NULL,   -- 표시 시각 (HH:MM:SS)
    "open"         DOUBLE PRECISION NOT NULL,
    "close"        DOUBLE PRECISION NOT NULL,
    "high"         DOUBLE PRECISION NOT NULL,
    "low"          DOUBLE PRECISION NOT NULL,
    "tick_count"   INTEGER          NOT NULL DEFAULT 0,
    "is_closed"    BOOLEAN          NOT NULL DEFAULT false,
    "created_at"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_candles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "price_candles_candle_index_key" ON "price_candles"("candle_index");

-- ─── price_state 테이블 (싱글톤 id=1) ────────────────────────────────────────
CREATE TABLE "price_state" (
    "id"             INTEGER          NOT NULL DEFAULT 1,
    "current_price"  DOUBLE PRECISION NOT NULL DEFAULT 0.052450,
    "current_tick"   INTEGER          NOT NULL DEFAULT 0,
    "current_candle" INTEGER          NOT NULL DEFAULT 0,
    "trend"          DOUBLE PRECISION NOT NULL DEFAULT 0,
    "last_tick_at"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_state_single_row" CHECK ("id" = 1)  -- 항상 1행만 유지
);

-- 초기 상태 행 삽입 (싱글톤)
INSERT INTO "price_state" ("id", "current_price", "current_tick", "current_candle", "trend", "last_tick_at", "updated_at")
VALUES (1, 0.052450, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- 초기 캔들 1개 삽입 (차트가 빈 상태로 시작하지 않도록)
INSERT INTO "price_candles" ("candle_index", "label", "open", "close", "high", "low", "tick_count", "is_closed", "created_at", "updated_at")
VALUES (0, TO_CHAR(NOW() AT TIME ZONE 'Asia/Seoul', 'HH24:MI:SS'), 0.052450, 0.052450, 0.052450, 0.052450, 0, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("candle_index") DO NOTHING;
