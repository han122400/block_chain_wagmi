import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { advancePriceTicks } from '@/lib/priceEngine'

// 화면에 표시할 최대 캔들 수 (1시간 = 720개, UI는 최근 80개만 표시)
const RETENTION_MS   = 60 * 60 * 1000   // 1시간 (priceEngine과 동일)
const MAX_RETURN     = 720               // 반환 최대값도 1시간치로 제한

/**
 * GET /api/price/candles?limit=80
 *
 * 1. 가격 엔진 실행 → 경과 시간만큼 틱 생성/저장 (이 요청이 틱 트리거)
 * 2. 최근 1시간치 캔들 중 limit개를 반환
 *
 * 보관 정책:
 *   - DB: 생성 시각 기준 최근 1시간만 유지 (priceEngine이 자동 정리)
 *   - API 응답: 최대 limit개 (기본 80, 최대 720)
 */
export async function GET(req: NextRequest) {
  const limit = Math.min(
    Number(req.nextUrl.searchParams.get('limit') ?? '80'),
    MAX_RETURN
  )

  try {
    // 경과 시간만큼 틱 생성 (DB 업데이트)
    await advancePriceTicks()

    const cutoff = new Date(Date.now() - RETENTION_MS)  // 1시간 전 기준선

    // 최신 상태 + 1시간 이내 캔들 조회 (최신순으로 limit개 → 다시 오름차순)
    const [state, rawCandles] = await Promise.all([
      prisma.priceState.findUnique({ where: { id: 1 } }),
      prisma.priceCandle.findMany({
        where:   { createdAt: { gte: cutoff } },   // 1시간 이내
        orderBy: { candleIndex: 'desc' },           // 최신부터
        take:    limit,                             // limit개만
      }),
    ])

    // desc로 가져왔으므로 다시 asc 정렬 (차트는 시간순)
    const candles = rawCandles.reverse()

    return NextResponse.json({
      currentPrice:  state?.currentPrice ?? 0.052450,
      currentTick:   state?.currentTick  ?? 0,
      retentionMin:  60,   // 클라이언트 참고용: 보관 기간(분)
      candles: candles.map((c: {
        candleIndex: number; label: string
        open: number; close: number; high: number; low: number; isClosed: boolean
      }) => ({
        candleIndex: c.candleIndex,
        time:        c.label,
        open:        c.open,
        close:       c.close,
        high:        c.high,
        low:         c.low,
        isClosed:    c.isClosed,
        candleRange: [c.low, c.high],   // Recharts BarChart용
      })),
    }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('[/api/price/candles]', error)
    return NextResponse.json({ error: '가격 데이터 조회 실패' }, { status: 500 })
  }
}
