import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

export async function GET() {
  try {
    // ① 싱글톤 풀 레코드 (없으면 0으로 upsert)
    const pool = await prisma.exchangePool.upsert({
      where:  { id: 1 },
      create: { id: 1, adminPoolPhb: 0, totalIssuedPhb: 0 },
      update: {},
    })

    // ② 현재 오픈된 모든 포지션의 증거금 합산 (활성 사용 중인 PHB)
    const activeMarginAgg = await prisma.position.aggregate({
      where: { isOpen: true },
      _sum:  { marginPhb: true },
    })
    const activeMarginPhb = activeMarginAgg._sum.marginPhb ?? 0

    // 비정상 음수 풀 방어 (레거시 계산 버그로 음수가 남을 수 있음)
    if (pool.adminPoolPhb < 0) {
      await prisma.exchangePool.update({
        where: { id: 1 },
        data: { adminPoolPhb: 0 },
      })
      pool.adminPoolPhb = 0
    }

    // ③ 유저 지갑에 남아있는 PHB 총량
    const userBalanceAgg = await prisma.user.aggregate({
      _sum: { phbBalance: true },
    })
    const userBalancePhb = userBalanceAgg._sum.phbBalance ?? 0

    // ④ PHB LIQUIDITY = 포지션 잠금 PHB + 관리자 공급 PHB
    const totalLiquidityPhb = activeMarginPhb + pool.adminPoolPhb

    // ⑤ TOTAL PHB = 사용자 지갑 PHB 합 + 관리자 공급 PHB
    const liveIssuedPhb = userBalancePhb + pool.adminPoolPhb

    return NextResponse.json({
      adminPoolPhb:      pool.adminPoolPhb,      // 관리자 공급 PHB
      totalLiquidityPhb,                         // PHB LIQUIDITY
      totalIssuedPhb:    liveIssuedPhb,          // TOTAL PHB
      activeMarginPhb,                           // 현재 포지션에 잠긴 PHB
    })
  } catch (e) {
    console.error('[exchange/stats]', e)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
