import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { createPublicClient, fallback, http } from 'viem'
import { sepolia } from 'viem/chains'
import { PHB_EXCHANGE_ADDRESS } from '@/config/contract'

// 교환 비율 상수 (컨트랙트와 동일하게 유지)
const PHB_PER_UNIT = 10    // 10 PHB
const ETH_UNIT = 0.001       // 0.001 ETH 당
const ETH_UNIT_WEI = BigInt('1000000000000000') // 0.001 ETH

/**
 * POST /api/phb/deposit
 * Body: { address?: string, txHash: string, ethAmount?: number }
 *
 * txHash를 기반으로 온체인 트랜잭션을 검증한 뒤 PHB를 적립합니다.
 * - 동일 txHash 재처리 방지
 * - 컨트랙트 주소/성공 여부/입금 단위 검증
 * - 입금자 주소는 요청값이 아니라 tx.from을 신뢰
 */
export async function POST(req: NextRequest) {
  try {
    const { txHash, ethAmount } = await req.json()

    // ─── 입력 검증 ────────────────────────────────────────────────────────────
    if (!txHash) {
      return NextResponse.json({ error: 'txHash가 필요합니다.' }, { status: 400 })
    }

    // txHash 형식 검증 (0x + 64자리 hex)
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return NextResponse.json({ error: '유효하지 않은 트랜잭션 해시입니다.' }, { status: 400 })
    }

    const rpcUrl = process.env.SEPOLIA_RPC_URL
    if (!rpcUrl) {
      return NextResponse.json({ error: 'SEPOLIA_RPC_URL이 설정되지 않았습니다.' }, { status: 500 })
    }

    // ─── 이중 입금 방지: txHash 중복 확인 ─────────────────────────────────────
    const existingDeposit = await prisma.depositLog.findUnique({ where: { txHash } })
    if (existingDeposit) {
      return NextResponse.json(
        { error: '이미 처리된 트랜잭션입니다.' },
        { status: 409 }
      )
    }

    // ─── 온체인 tx 검증 ───────────────────────────────────────────────────────
    const client = createPublicClient({
      chain: sepolia,
      transport: fallback([
        http(rpcUrl),
        http('https://ethereum-sepolia-rpc.publicnode.com'),
        http('https://rpc2.sepolia.org'),
      ]),
    })

    const hash = txHash as `0x${string}`
    let tx: Awaited<ReturnType<typeof client.getTransaction>> | null = null
    let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>> | null = null

    // 공개 RPC 타임아웃/지연 대응: 짧게 재시도
    for (let i = 0; i < 3; i++) {
      try {
        tx = await client.getTransaction({ hash })
        receipt = await client.getTransactionReceipt({ hash })
        break
      } catch {
        if (i === 2) throw new Error('온체인 트랜잭션 조회에 실패했습니다. 잠시 후 다시 시도해주세요.')
        await new Promise(r => setTimeout(r, 600))
      }
    }

    if (!tx || !receipt) {
      throw new Error('온체인 트랜잭션 조회에 실패했습니다.')
    }

    if (receipt.status !== 'success') {
      return NextResponse.json({ error: '실패한 트랜잭션은 반영할 수 없습니다.' }, { status: 400 })
    }
    if (!tx.to || tx.to.toLowerCase() !== PHB_EXCHANGE_ADDRESS.toLowerCase()) {
      return NextResponse.json({ error: '해당 tx는 거래소 컨트랙트 입금이 아닙니다.' }, { status: 400 })
    }
    if (tx.value <= 0n || tx.value % ETH_UNIT_WEI !== 0n) {
      return NextResponse.json({ error: '0.001 ETH 단위 입금만 반영됩니다.' }, { status: 400 })
    }

    const normalizedAddress = tx.from.toLowerCase()
    const units = Number(tx.value / ETH_UNIT_WEI)
    const ethAmountFromChain = units * ETH_UNIT
    const phbAmount = units * PHB_PER_UNIT

    // 클라이언트가 ethAmount를 보낸 경우엔 온체인 값과 일치하는지 점검
    if (typeof ethAmount === 'number') {
      if (ethAmount <= 0 || Math.abs(ethAmount - ethAmountFromChain) > 0.000001) {
        return NextResponse.json({ error: '요청 ETH 수량이 온체인 tx와 일치하지 않습니다.' }, { status: 400 })
      }
    }

    // ─── 트랜잭션: 유저 생성/업데이트 + 입금 기록 + 발행 PHB 누계 ────────────
    const result = await prisma.$transaction(async (tx: any) => {
      // 유저가 없으면 생성, 있으면 PHB 잔액 추가
      const user = await tx.user.upsert({
        where: { address: normalizedAddress },
        update: { phbBalance: { increment: phbAmount } },
        create: { address: normalizedAddress, phbBalance: phbAmount },
      })

      // 입금 기록 저장
      await tx.depositLog.create({
        data: {
          userAddress: normalizedAddress,
          txHash,
          ethAmount: ethAmountFromChain,
          phbAmount,
        },
      })

      // 거래소 풀 총 발행 PHB 누적
      await tx.exchangePool.upsert({
        where:  { id: 1 },
        create: { id: 1, totalLiquidityEth: 0, totalIssuedPhb: phbAmount },
        update: { totalIssuedPhb: { increment: phbAmount } },
      })

      return user
    })

    return NextResponse.json({
      success: true,
      address: normalizedAddress,
      phbBalance: result.phbBalance,
      phbAdded: phbAmount,
      message: `${phbAmount} PHB가 충전되었습니다.`,
    })
  } catch (error) {
    console.error('[/api/phb/deposit]', error)
    return NextResponse.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 })
  }
}
