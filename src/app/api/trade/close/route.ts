import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

const MAINTENANCE_MARGIN_RATE = 0.25  // 청산 유지증거금률 25%

function calcFeeRate(leverage: number): number {
  return 30 + Math.floor(((leverage - 1) * 20) / 99)
}

function calcLiquidationPrice(entryPrice: number, leverage: number, isLong: boolean): number {
  const bufferRatio = 1 - MAINTENANCE_MARGIN_RATE
  if (isLong) return entryPrice * (1 - bufferRatio / leverage)
  return entryPrice * (1 + bufferRatio / leverage)
}

/**
 * POST /api/trade/close
 * Body: { address, exitPrice }
 *
 * 포지션을 종료하고 PnL을 PHB로 정산합니다.
 * 온체인 트랜잭션 없음 → 즉시 처리
 */
export async function POST(req: NextRequest) {
  try {
    const { address, exitPrice } = await req.json()

    if (!address || !exitPrice) {
      return NextResponse.json({ error: '필수 파라미터가 없습니다.' }, { status: 400 })
    }

    const normalizedAddress = address.toLowerCase()
    const currentPrice = Number(exitPrice)

    const result = await prisma.$transaction(async (tx: any) => {
      // 오픈 포지션 조회
      const position = await tx.position.findFirst({
        where: { userAddress: normalizedAddress, isOpen: true },
      })
      if (!position) {
        throw new Error('오픈된 포지션이 없습니다.')
      }

      const { marginPhb, entryPrice, leverage, isLong } = position

      // ─── PnL 계산 (기존 로직과 동일, ETH→PHB로 단위 변경) ──────────────────
      const liqPrice = calcLiquidationPrice(entryPrice, leverage, isLong)

      // 청산 여부 확인
      const isLiquidated = isLong
        ? currentPrice <= liqPrice
        : currentPrice >= liqPrice

      let pnlPhb: number
      let isProfit: boolean
      let payoutPhb: number

      if (isLiquidated) {
        // 강제 청산: 원금 전부 소실
        pnlPhb    = -marginPhb
        isProfit  = false
        payoutPhb = 0
      } else {
        const priceDiff   = currentPrice - entryPrice
        const directedDiff = isLong ? priceDiff : -priceDiff
        const rawPnL      = (marginPhb * leverage * directedDiff) / entryPrice

        if (rawPnL >= 0) {
          // 수익: 수수료 차감
          const feeRate  = calcFeeRate(leverage)
          const fee      = rawPnL * (feeRate / 100)
          pnlPhb         = rawPnL - fee
          isProfit       = true
          payoutPhb      = marginPhb + pnlPhb
        } else {
          // 손실: 원금 초과 손실 방지
          const lossAbs = Math.min(Math.abs(rawPnL), marginPhb)
          pnlPhb        = -lossAbs
          isProfit      = false
          payoutPhb     = marginPhb - lossAbs
        }
      }

      // 거래소 풀 잔고 업데이트 (음수 방지)
      const pool = await tx.exchangePool.upsert({
        where:  { id: 1 },
        create: { id: 1, adminPoolPhb: 0, totalIssuedPhb: 0 },
        update: {},
      })
      const adminPoolDelta = marginPhb - payoutPhb
      const nextAdminPool = Math.max(0, pool.adminPoolPhb + adminPoolDelta)

      // 포지션 종료 + PHB 정산
      const updatedPosition = await tx.position.update({
        where: { id: position.id },
        data: {
          isOpen:    false,
          closedAt:  new Date(),
          exitPrice: currentPrice,
          pnlPhb,
          isProfit,
        },
      })

      const updatedUser = await tx.user.update({
        where: { address: normalizedAddress },
        data: { phbBalance: { increment: payoutPhb } },
      })

      await tx.exchangePool.update({
        where: { id: 1 },
        data:  { adminPoolPhb: nextAdminPool },
      })

      return {
        position: updatedPosition,
        phbBalance: updatedUser.phbBalance,
        pnlPhb,
        isProfit,
        payoutPhb,
        isLiquidated,
      }
    })

    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    console.error('[/api/trade/close]', error)
    const msg = error?.message || '서버 오류가 발생했습니다.'
    return NextResponse.json({ error: msg }, { status: 400 })
  }
}
