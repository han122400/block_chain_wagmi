import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

// 수수료율 (수익 시 부과)
const BASE_FEE_RATE = 30     // 기본 30%
const MAX_FEE_RATE  = 50     // 최대 50% (100배 레버리지)

function calcFeeRate(leverage: number): number {
  return BASE_FEE_RATE + Math.floor(((leverage - 1) * 20) / 99)
}

/**
 * POST /api/trade/open
 * Body: { address, marginPhb, entryPrice, leverage, isLong }
 *
 * PHB를 증거금으로 사용하여 포지션을 오픈합니다.
 * 온체인 트랜잭션 없음 → 즉시 처리
 */
export async function POST(req: NextRequest) {
  try {
    const { address, marginPhb, entryPrice, leverage, isLong } = await req.json()

    if (!address || !marginPhb || !entryPrice || !leverage || isLong === undefined) {
      return NextResponse.json({ error: '필수 파라미터가 없습니다.' }, { status: 400 })
    }

    const normalizedAddress = address.toLowerCase()
    const margin = Number(marginPhb)
    const lev    = Number(leverage)

    // ─── 입력 검증 ────────────────────────────────────────────────────────────
    if (margin < 1) {
      return NextResponse.json({ error: '최소 증거금은 1 PHB입니다.' }, { status: 400 })
    }
    if (lev < 1 || lev > 100) {
      return NextResponse.json({ error: '레버리지는 1~100 사이입니다.' }, { status: 400 })
    }

    const result = await prisma.$transaction(async (tx: any) => {
      // PHB 잔액 확인
      const user = await tx.user.findUnique({ where: { address: normalizedAddress } })
      if (!user || user.phbBalance < margin) {
        throw new Error('PHB 잔액이 부족합니다.')
      }

      // 기존 오픈 포지션 확인 (1개만 허용)
      const existingPosition = await tx.position.findFirst({
        where: { userAddress: normalizedAddress, isOpen: true },
      })
      if (existingPosition) {
        throw new Error('이미 오픈된 포지션이 있습니다.')
      }

      // PHB 차감
      const updatedUser = await tx.user.update({
        where: { address: normalizedAddress },
        data: { phbBalance: { decrement: margin } },
      })

      // 포지션 생성
      const position = await tx.position.create({
        data: {
          userAddress: normalizedAddress,
          marginPhb: margin,
          entryPrice: Number(entryPrice),
          leverage: lev,
          isLong: Boolean(isLong),
        },
      })

      return { position, phbBalance: updatedUser.phbBalance }
    })

    return NextResponse.json({
      success: true,
      position: result.position,
      phbBalance: result.phbBalance,
      feeRate: calcFeeRate(lev),
    })
  } catch (error: any) {
    console.error('[/api/trade/open]', error)
    const msg = error?.message || '서버 오류가 발생했습니다.'
    return NextResponse.json({ error: msg }, { status: 400 })
  }
}
