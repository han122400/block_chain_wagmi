import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

const OWNER_ADDRESS = process.env.NEXT_PUBLIC_OWNER_ADDRESS?.toLowerCase()

/**
 * POST /api/admin/emergency-withdraw
 * 거래소 풀 PHB(adminPoolPhb) + 전체 발행 PHB(totalIssuedPhb) 전액을
 * 관리자 개인 PHB 잔고로 이전하고 풀을 0으로 초기화합니다.
 *
 * ※ 개별 사용자의 phbBalance는 그대로 유지됩니다.
 */
export async function POST(req: NextRequest) {
  try {
    const { callerAddress } = await req.json()

    if (!callerAddress || callerAddress.toLowerCase() !== OWNER_ADDRESS) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const normalizedAddress = callerAddress.toLowerCase()

    const result = await prisma.$transaction(async (tx: any) => {
      // 현재 풀 잔고 조회
      const pool = await tx.exchangePool.upsert({
        where:  { id: 1 },
        create: { id: 1, adminPoolPhb: 0, totalIssuedPhb: 0 },
        update: {},
      })

      // 유동성 풀 PHB만 관리자에게 귀속 (발행분은 지표일 뿐 회수 대상 아님)
      // 음수 값은 비정상 데이터로 간주하고 0으로 처리
      const amountToReturn = Math.max(0, pool.adminPoolPhb)

      // 풀 완전 초기화
      await tx.exchangePool.update({
        where: { id: 1 },
        data:  { adminPoolPhb: 0, totalIssuedPhb: 0 },
      })

      // 관리자 PHB 잔고에 추가
      const admin = await tx.user.upsert({
        where:  { address: normalizedAddress },
        create: { address: normalizedAddress, phbBalance: amountToReturn },
        update: { phbBalance: { increment: amountToReturn } },
      })

      return {
        returned:     amountToReturn,
        adminBalance: admin.phbBalance,
        poolPhb:      pool.adminPoolPhb,
        issuedPhb:    pool.totalIssuedPhb,
      }
    })

    return NextResponse.json({
      ok:           true,
      returned:     result.returned,
      adminBalance: result.adminBalance,
      message:      `풀 유동 PHB ${result.returned} PHB가 내 지갑으로 이전되었습니다.`,
    })
  } catch (e: any) {
    console.error('[admin/emergency-withdraw]', e)
    return NextResponse.json({ error: e.message ?? 'Internal error' }, { status: 500 })
  }
}
