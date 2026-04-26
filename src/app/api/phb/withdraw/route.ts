import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { PHB_EXCHANGE_ABI, PHB_EXCHANGE_ADDRESS } from '@/config/contract'

const PHB_PER_UNIT = 10
const ETH_PER_UNIT = BigInt('1000000000000000') // 0.001 ETH in wei

/**
 * POST /api/phb/withdraw
 * Body: { address: string, phbAmount: number }
 *
 * 흐름:
 * 1. DB에서 PHB 잔고 & 거래소 풀 확인
 * 2. 서버 지갑(OWNER_PRIVATE_KEY)으로 withdrawETHForUser() 호출 → 사용자 지갑에 ETH 전송
 * 3. 트랜잭션 해시 반환 → 프론트에서 온체인 컨펌 감지
 * 4. 컨펌 후 PHB 차감 (step4 API로 호출)
 */
export async function POST(req: NextRequest) {
  try {
    const { address, phbAmount } = await req.json()

    if (!address || !phbAmount) {
      return NextResponse.json({ error: '필수 파라미터가 없습니다.' }, { status: 400 })
    }

    const normalizedAddress = address.toLowerCase()
    const amount = Number(phbAmount)

    if (amount <= 0 || amount % PHB_PER_UNIT !== 0) {
      return NextResponse.json({ error: '10 PHB 단위로만 인출 가능합니다.' }, { status: 400 })
    }

    // ─── DB 사전 검증 (차감은 컨펌 후) ───────────────────────────────────────
    const user = await prisma.user.findUnique({ where: { address: normalizedAddress } })
    if (!user || user.phbBalance < amount) {
      return NextResponse.json({ error: 'PHB 잔액이 부족합니다.' }, { status: 400 })
    }

    // ─── 환경변수 확인 ─────────────────────────────────────────────────────────
    const rawKey = process.env.OWNER_PRIVATE_KEY
    const rpcUrl = process.env.SEPOLIA_RPC_URL

    if (!rawKey || !rpcUrl) {
      return NextResponse.json({ error: 'OWNER_PRIVATE_KEY 또는 SEPOLIA_RPC_URL이 설정되지 않았습니다.' }, { status: 500 })
    }

    const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`
    if (privateKey.length !== 66) {
      return NextResponse.json({
        error: 'OWNER_PRIVATE_KEY가 올바르지 않습니다. MetaMask > 계정 세부정보 > 개인 키 표시 에서 64자리 키를 복사하세요.'
      }, { status: 500 })
    }

    // ─── 컨트랙트 잔고 확인 ────────────────────────────────────────────────────
    const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })

    const contractBalance = await publicClient.readContract({
      address:      PHB_EXCHANGE_ADDRESS as `0x${string}`,
      abi:          PHB_EXCHANGE_ABI,
      functionName: 'getContractBalance',
    }) as bigint

    const ethNeeded = ETH_PER_UNIT * BigInt(amount / PHB_PER_UNIT)
    if (contractBalance < ethNeeded) {
      return NextResponse.json({
        error: `거래소 컨트랙트 ETH 부족 (잔고: ${Number(contractBalance) / 1e18} ETH, 필요: ${Number(ethNeeded) / 1e18} ETH)`
      }, { status: 503 })
    }

    // ─── 서버 지갑으로 ETH 전송 ────────────────────────────────────────────────
    const account      = privateKeyToAccount(privateKey as `0x${string}`)
    const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) })

    const txHash = await walletClient.writeContract({
      address:      PHB_EXCHANGE_ADDRESS as `0x${string}`,
      abi:          PHB_EXCHANGE_ABI,
      functionName: 'withdrawETHForUser',
      args:         [address as `0x${string}`, BigInt(amount)],
    })

    return NextResponse.json({
      success: true,
      txHash,
      phbAmount:   amount,
      ethReturned: Number(ethNeeded) / 1e18,
      message: `TX 전송 완료! 블록 컨펌 후 PHB가 차감됩니다.`,
    })
  } catch (e: any) {
    console.error('[/api/phb/withdraw]', e)
    return NextResponse.json({ error: e.shortMessage ?? e.message ?? '서버 오류' }, { status: 500 })
  }
}
