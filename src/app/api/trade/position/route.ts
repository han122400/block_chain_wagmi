import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

/**
 * GET /api/trade/position?address=0x...
 * 현재 오픈된 포지션을 반환합니다.
 */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')?.toLowerCase()

  if (!address) {
    return NextResponse.json({ error: '지갑 주소가 필요합니다.' }, { status: 400 })
  }

  const position = await prisma.position.findFirst({
    where: { userAddress: address, isOpen: true },
  })

  return NextResponse.json({ position: position ?? null })
}
