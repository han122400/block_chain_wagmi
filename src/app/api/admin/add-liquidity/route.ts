import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

const OWNER_ADDRESS = process.env.NEXT_PUBLIC_OWNER_ADDRESS?.toLowerCase()

/**
 * POST /api/admin/add-liquidity
 * Body: { callerAddress: string, phbAmount: number }
 *
 * 관리자의 PHB 잔액에서 phbAmount만큼 차감하여 거래소 풀(adminPoolPhb)에 이동.
 * 온체인 트랜잭션 없이 순수 DB 트랜잭션으로 처리.
 */
export async function POST(req: NextRequest) {
  try {
    const { callerAddress, phbAmount } = await req.json()

    // 관리자 주소 검증
    if (!callerAddress || callerAddress.toLowerCase() !== OWNER_ADDRESS) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
    if (!phbAmount || phbAmount <= 0) {
      return NextResponse.json({ error: 'phbAmount는 0보다 커야 합니다.' }, { status: 400 })
    }

    const normalizedAddress = callerAddress.toLowerCase()

    const result = await prisma.$transaction(async (tx: any) => {
      // 관리자 잔고 확인
      const admin = await tx.user.findUnique({ where: { address: normalizedAddress } })
      if (!admin || admin.phbBalance < phbAmount) {
        throw new Error(`PHB 잔고 부족: 보유 ${admin?.phbBalance ?? 0} PHB, 요청 ${phbAmount} PHB`)
      }

      // 관리자 PHB 차감
      const updatedAdmin = await tx.user.update({
        where: { address: normalizedAddress },
        data:  { phbBalance: { decrement: phbAmount } },
      })

      // 거래소 풀에 PHB 추가
      const pool = await tx.exchangePool.upsert({
        where:  { id: 1 },
        create: { id: 1, adminPoolPhb: phbAmount, totalIssuedPhb: 0 },
        update: { adminPoolPhb: { increment: phbAmount } },
      })

      return { adminBalance: updatedAdmin.phbBalance, adminPoolPhb: pool.adminPoolPhb }
    })

    return NextResponse.json({
      ok: true,
      adminBalance: result.adminBalance,
      adminPoolPhb: result.adminPoolPhb,
      message: `${phbAmount} PHB가 거래소 풀에 추가되었습니다.`,
    })
  } catch (e: any) {
    console.error('[admin/add-liquidity]', e)
    return NextResponse.json({ error: e.message ?? 'Internal error' }, { status: 500 })
  }
}
