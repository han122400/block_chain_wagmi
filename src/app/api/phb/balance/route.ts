import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { createPublicClient, fallback, http } from 'viem'
import { sepolia } from 'viem/chains'
import { PHB_EXCHANGE_ADDRESS } from '@/config/contract'

const RECONCILE_BLOCK_WINDOW = 20000n

/**
 * GET /api/phb/balance?address=0x...
 * 사용자의 PHB 잔액을 반환합니다.
 */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')?.toLowerCase() as `0x${string}` | undefined
  const shouldReconcile = req.nextUrl.searchParams.get('reconcile') === '1'

  if (!address) {
    return NextResponse.json({ error: '지갑 주소가 필요합니다.' }, { status: 400 })
  }

  // 지갑 재연결/최초 방문 시에도 user 행이 존재하도록 보장
  let user = await prisma.user.upsert({
    where: { address },
    update: {},
    create: { address, phbBalance: 0 },
  })

  // 기본 잔액 조회는 DB만 읽는다. 온체인 복구는 느리므로 명시 요청 때만 실행한다.
  const rpcUrl = process.env.SEPOLIA_RPC_URL
  if (shouldReconcile && rpcUrl) {
    try {
      const pool = await prisma.exchangePool.upsert({
        where: { id: 1 },
        create: { id: 1, totalLiquidityEth: 0, totalIssuedPhb: 0, adminPoolPhb: 0 },
        update: {},
      })

      const client = createPublicClient({
        chain: sepolia,
        transport: fallback([
          http(rpcUrl),
          http('https://ethereum-sepolia-rpc.publicnode.com'),
          http('https://rpc2.sepolia.org'),
        ]),
      })

      const latest = await client.getBlockNumber()
      const fromBlock =
        latest > RECONCILE_BLOCK_WINDOW ? latest - RECONCILE_BLOCK_WINDOW : 0n

      const logs = await client.getLogs({
        address: PHB_EXCHANGE_ADDRESS,
        event: {
          type: 'event',
          name: 'ETHDeposited',
          inputs: [
            { indexed: true, name: 'user', type: 'address' },
            { indexed: false, name: 'ethAmount', type: 'uint256' },
            { indexed: false, name: 'phbAmount', type: 'uint256' },
            { indexed: false, name: 'timestamp', type: 'uint256' },
          ],
        },
        args: { user: address },
        fromBlock,
        toBlock: 'latest',
      })

      // 초기화 시점 이전의 과거 온체인 로그는 자동복구 대상에서 제외
      // (수동 로그 초기화 후 과거 tx가 다시 적립되는 문제 방지)
      // 이벤트에 이미 timestamp가 있으므로 추가 RPC(getBlock) 없이 빠르게 필터링
      const baselineTs = BigInt(Math.floor(pool.updatedAt.getTime() / 1000))
      const candidateLogs = logs.filter(
        l => (l.args.timestamp ?? 0n) >= baselineTs
      )

      if (candidateLogs.length > 0) {
        const txHashes = candidateLogs.map(l => l.transactionHash)
        const existing = await prisma.depositLog.findMany({
          where: { txHash: { in: txHashes } },
          select: { txHash: true },
        })
        const existingSet = new Set(existing.map(e => e.txHash.toLowerCase()))

        const missing = candidateLogs.filter(
          l => !existingSet.has(l.transactionHash.toLowerCase())
        )

        if (missing.length > 0) {
          const rows = missing.map(l => ({
            userAddress: address,
            txHash: l.transactionHash,
            ethAmount: Number((l.args.ethAmount ?? 0n).toString()) / 1e18,
            phbAmount: Number((l.args.phbAmount ?? 0n).toString()),
          }))
          const phbToAdd = rows.reduce((sum, r) => sum + r.phbAmount, 0)

          const result = await prisma.$transaction(async (tx: any) => {
            await tx.depositLog.createMany({
              data: rows,
              skipDuplicates: true,
            })

            const updatedUser = await tx.user.update({
              where: { address },
              data: { phbBalance: { increment: phbToAdd } },
            })

            await tx.exchangePool.upsert({
              where: { id: 1 },
              create: { id: 1, totalLiquidityEth: 0, totalIssuedPhb: phbToAdd, adminPoolPhb: 0 },
              update: { totalIssuedPhb: { increment: phbToAdd } },
            })

            return updatedUser
          })

          user = result
        }
      }
    } catch (e) {
      console.error('[phb/balance reconcile]', e)
    }
  }

  return NextResponse.json(
    { phbBalance: user.phbBalance },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
