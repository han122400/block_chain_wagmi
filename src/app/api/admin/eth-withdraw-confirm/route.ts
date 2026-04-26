import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

const OWNER_ADDRESS = process.env.NEXT_PUBLIC_OWNER_ADDRESS?.toLowerCase()

/**
 * POST /api/admin/eth-withdraw-confirm
 * 관리자가 selfWithdraw() 온체인 TX 성공 후 호출.
 * DB의 관리자 phbBalance를 인출한 PHB만큼 차감합니다.
 *
 * Body: { callerAddress: string, phbAmount: number }
 */
export async function POST(req: NextRequest) {
  try {
    const { callerAddress, phbAmount } = await req.json()

    if (!callerAddress || callerAddress.toLowerCase() !== OWNER_ADDRESS) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
    if (!phbAmount || phbAmount <= 0) {
      return NextResponse.json({ error: '유효하지 않은 PHB 수량입니다.' }, { status: 400 })
    }

    const normalizedAddress = callerAddress.toLowerCase()

    const user = await prisma.user.update({
      where: { address: normalizedAddress },
      data:  { phbBalance: { decrement: phbAmount } },
    })

    // 음수 방지
    if (user.phbBalance < 0) {
      await prisma.user.update({
        where: { address: normalizedAddress },
        data:  { phbBalance: 0 },
      })
    }

    return NextResponse.json({
      ok:         true,
      phbBalance: Math.max(0, user.phbBalance),
      message:    `${phbAmount} PHB 차감 완료 (ETH 인출 반영)`,
    })
  } catch (e: any) {
    console.error('[admin/eth-withdraw-confirm]', e)
    return NextResponse.json({ error: e.message ?? 'Internal error' }, { status: 500 })
  }
}
