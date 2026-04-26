import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

const OWNER_ADDRESS = process.env.NEXT_PUBLIC_OWNER_ADDRESS?.toLowerCase()

/**
 * POST /api/admin/reset-db
 * 포지션/충전기록/세션/풀 상태를 초기화합니다.
 * 사용자 행(User)은 유지하고 phbBalance만 0으로 리셋합니다.
 * price_candles, price_state는 선택적으로 초기화합니다.
 */
export async function POST(req: NextRequest) {
  try {
    const { callerAddress, resetPrice } = await req.json()

    if (!callerAddress || callerAddress.toLowerCase() !== OWNER_ADDRESS) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    await prisma.$transaction(async (tx: any) => {
      // 1. 포지션 전체 삭제
      await tx.position.deleteMany({})

      // 2. 충전 기록 전체 삭제
      await tx.depositLog.deleteMany({})

      // 3. 입장 세션 전체 삭제
      await tx.userSession.deleteMany({})

      // 4. 사용자 잔고만 초기화 (계정 자체는 유지)
      await tx.user.updateMany({
        data: { phbBalance: 0 },
      })

      // 5. 거래소 풀 초기화 (행 삭제 후 재생성)
      await tx.exchangePool.deleteMany({})
      await tx.exchangePool.create({
        data: { id: 1, totalIssuedPhb: 0, adminPoolPhb: 0 }
      })

      // 6. 가격 데이터 초기화 (선택)
      if (resetPrice) {
        await tx.priceCandle.deleteMany({})
        await tx.priceState.deleteMany({})
        // 가격 정보 재생성 (기준 가격으로)
        await tx.priceState.create({
          data: {
            id:            1,
            currentPrice:  0.052450,
            currentTick:   0,
            currentCandle: 0,
            trend:         0,
            lastTickAt:    new Date(),
          }
        })
      }
    })

    return NextResponse.json({
      ok: true,
      message: `DB 초기화 완료${resetPrice ? ' (가격 포함)' : ' (가격 유지)'}`,
    })
  } catch (e: any) {
    console.error('[admin/reset-db]', e)
    return NextResponse.json({ error: e.message ?? 'Internal error' }, { status: 500 })
  }
}
