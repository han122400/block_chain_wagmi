/**
 * src/lib/priceEngine.ts
 *
 * 서버 사이드 가격 생성 엔진 (최적화 버전)
 */

import prisma from '@/lib/prisma'

const BASE_PRICE          = 0.052450
const TICKS_PER_CANDLE    = 5
const MAX_CATCH_UP_TICKS  = 30
const CANDLE_RETENTION_MS = 60 * 60 * 1000 
const FLASH_PROBABILITY   = 0.03
const FLASH_COOLDOWN      = 45

let flashCooldown = 0
let isAdvancing = false // 동시 실행 방지 플래그

function seededRandom(seed: number): number {
  seed = (seed + 0x6D2B79F5) >>> 0
  seed = Math.imul(seed ^ (seed >>> 15), seed | 1)
  seed ^= seed + Math.imul(seed ^ (seed >>> 7), seed | 61)
  return ((seed ^ (seed >>> 14)) >>> 0) / 4294967296
}

function computeNextTick(
  prevPrice: number,
  prevTrend: number,
  tickNum: number
): { price: number; trend: number; flashType: 'PUMP' | 'CRASH' | null } {
  const r1 = seededRandom(tickNum * 3 + 1)
  const r2 = seededRandom(tickNum * 3 + 2)
  const r3 = seededRandom(tickNum * 3 + 3)

  let flashMultiplier = 1
  let flashType: 'PUMP' | 'CRASH' | null = null

  if (flashCooldown <= 0 && r1 < FLASH_PROBABILITY) {
    const isPump  = r2 > 0.5
    const mag     = 0.05 + r2 * 0.07
    flashMultiplier = isPump ? (1 + mag) : (1 - mag)
    flashCooldown   = FLASH_COOLDOWN
    flashType       = isPump ? 'PUMP' : 'CRASH'
  } else {
    flashCooldown = Math.max(0, flashCooldown - 1)
  }

  let trend = prevTrend * 0.50 + (r1 - 0.5) * 0.0040
  if (r2 < 0.35) trend = -trend * (0.9 + r3 * 0.8)

  const gravity  = (BASE_PRICE - prevPrice) * 0.003
  const noise    = (r3 - 0.5) * 0.0028
  const newPrice = Math.max(0.01, (prevPrice + trend + gravity + noise) * flashMultiplier)

  return { price: newPrice, trend, flashType }
}

export async function advancePriceTicks(): Promise<void> {
  if (isAdvancing) return // 이미 다른 요청이 업데이트 중이면 중단
  isAdvancing = true

  try {
    await prisma.$transaction(async (tx: any) => {
      // 1. 상태 읽기 (Row Lock)
      const state = await tx.$queryRaw`SELECT * FROM price_state WHERE id = 1 FOR UPDATE`
      if (!state || state.length === 0) {
        // 데이터가 없으면 초기화 후 종료 (다음 호출 때 처리)
        await tx.priceState.upsert({
          where: { id: 1 },
          create: { id: 1, currentPrice: BASE_PRICE, currentTick: 0, currentCandle: 0, trend: 0, lastTickAt: new Date() },
          update: {}
        })
        return
      }

      const s = state[0]
      const now = new Date()
      const elapsedSec = Math.floor((now.getTime() - new Date(s.last_tick_at).getTime()) / 1000)
      const ticksToGen = Math.min(elapsedSec, MAX_CATCH_UP_TICKS)

      if (ticksToGen <= 0) return

      let price       = s.current_price
      let trend       = s.trend
      let tickNum     = s.current_tick
      let candleIndex = s.current_candle

      // 메모리에서 한꺼번에 계산 (DB 접근 최소화)
      for (let i = 0; i < ticksToGen; i++) {
        tickNum++
        const { price: nextPrice, trend: nextTrend } = computeNextTick(price, trend, tickNum)
        price = nextPrice
        trend = nextTrend

        const tickInCandle = tickNum % TICKS_PER_CANDLE
        const isNewCandle  = tickInCandle === 1 && tickNum > 1 // 첫 틱일 때

        if (isNewCandle) {
          // 이전 캔들 닫기
          await tx.priceCandle.updateMany({
            where: { candleIndex, isClosed: false },
            data: { isClosed: true }
          })
          candleIndex++
        }

        const timeLabel = new Date().toLocaleTimeString('ko-KR', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        })

        // 캔들 업데이트/생성
        await tx.priceCandle.upsert({
          where: { candleIndex },
          create: {
            candleIndex, label: timeLabel, open: price, close: price, high: price, low: price, tickCount: 1, isClosed: false
          },
          update: {
            close: price,
            tickCount: { increment: 1 },
            label: timeLabel
          }
        })

        // High/Low 반영
        await tx.$executeRaw`
          UPDATE price_candles 
          SET high = CASE WHEN ${price} > high THEN ${price} ELSE high END,
              low  = CASE WHEN ${price} < low  THEN ${price} ELSE low  END
          WHERE candle_index = ${candleIndex}
        `
      }

      // 최종 상태 저장
      await tx.priceState.update({
        where: { id: 1 },
        data: {
          currentPrice:   price,
          currentTick:    tickNum,
          currentCandle:  candleIndex,
          trend:          trend,
          lastTickAt:     now
        }
      })
      
      // 오래된 데이터 삭제
      const cutoff = new Date(now.getTime() - CANDLE_RETENTION_MS)
      await tx.priceCandle.deleteMany({ where: { createdAt: { lt: cutoff } } })

    }, { timeout: 15000 })
  } catch (e) {
    console.error('[advancePriceTicks Error]', e)
  } finally {
    isAdvancing = false
  }
}
