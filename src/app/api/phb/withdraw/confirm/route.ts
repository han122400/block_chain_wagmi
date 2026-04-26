import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

/**
 * POST /api/phb/withdraw/confirm
 * Body: { address: string, phbAmount: number, txHash: string }
 *
 * 온체인 TX 컨펌 후 프론트에서 호출.
 * DB에서 PHB 차감 + 풀에서도 차감.
 */
export async function POST(req: NextRequest) {
  try {
    const { address, phbAmount, txHash } = await req.json()

    if (!address || !phbAmount || !txHash) {
      return NextResponse.json({ error: '필수 파라미터 누락' }, { status: 400 })
    }

    const normalizedAddress = address.toLowerCase()
    const amount = Number(phbAmount)

    const result = await prisma.$transaction(async (tx: any) => {
      const user = await tx.user.findUnique({ where: { address: normalizedAddress } })
      if (!user || user.phbBalance < amount) {
        throw new Error('PHB 잔액이 부족합니다.')
      }

      const updatedUser = await tx.user.update({
        where: { address: normalizedAddress },
        data:  { phbBalance: { decrement: amount } },
      })

      // 환전(소각)된 PHB는 전체 발행량에서도 차감 (0 미만 방지)
      const pool = await tx.exchangePool.upsert({
        where: { id: 1 },
        create: { id: 1, totalLiquidityEth: 0, totalIssuedPhb: 0, adminPoolPhb: 0 },
        update: {},
      })
      await tx.exchangePool.update({
        where: { id: 1 },
        data: { totalIssuedPhb: Math.max(0, pool.totalIssuedPhb - amount) },
      })

      return { newPhbBalance: updatedUser.phbBalance }
    })

    return NextResponse.json({
      success:       true,
      newPhbBalance: result.newPhbBalance,
      message:       `${amount} PHB 차감 완료`,
    })
  } catch (e: any) {
    console.error('[withdraw/confirm]', e)
    return NextResponse.json({ error: e.message ?? 'Internal error' }, { status: 500 })
  }
}
