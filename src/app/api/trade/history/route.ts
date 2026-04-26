import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

/**
 * GET /api/trade/history?address=0x...&limit=10
 * 거래 기록을 최신순으로 반환합니다. address 미입력 시 전체 기록 반환.
 */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')?.toLowerCase()
  const limit   = Number(req.nextUrl.searchParams.get('limit') ?? '10')

  try {
    const positions = await prisma.position.findMany({
      where: {
        ...(address ? { userAddress: address } : {}),
        isOpen: false,  // 종료된 포지션만
      },
      orderBy: { closedAt: 'desc' },
      take: Math.min(limit, 50),
    })

    return NextResponse.json({ history: positions })
  } catch (error) {
    console.error('[/api/trade/history]', error)
    return NextResponse.json({ error: '거래 기록 조회 실패' }, { status: 500 })
  }
}
