'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useAccount, useConnect, useDisconnect, useWriteContract, useWaitForTransactionReceipt, useReadContract, useBalance, usePublicClient } from 'wagmi'
import { parseEther } from 'viem'
import { PHB_EXCHANGE_ABI, PHB_EXCHANGE_ADDRESS } from '@/config/contract'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'
import {
  Wallet, LogOut, TrendingUp, TrendingDown, Clock,
  ArrowRightLeft, BarChart3, AlertTriangle,
  Zap, Coins, ArrowDownToLine, ArrowUpFromLine, RefreshCw,
  Signal, ShieldAlert, Waves, Timer, Lock
} from 'lucide-react'

// ─── 상수 ─────────────────────────────────────────────────────────────────────
const MAINTENANCE_MARGIN_RATE = 0.25
const PHB_PER_ETH_UNIT        = 10     // 0.001 ETH = 10 PHB
const ETH_UNIT                = 0.001  // 충전 단위 (ETH)
const PRICE_POLL_MS           = 1000
const EXCHANGE_STATS_POLL_MS  = 1000
const ACCOUNT_DATA_POLL_MS    = 1000
const DEPOSIT_MIN_ETH         = 0.001
const DEPOSIT_MAX_ETH         = 0.05
const DEPOSIT_STEP_ETH        = 0.001

function calcLiquidationPrice(entryPrice: number, leverage: number, isLong: boolean): number {
  const bufferRatio = 1 - MAINTENANCE_MARGIN_RATE
  return isLong
    ? entryPrice * (1 - bufferRatio / leverage)
    : entryPrice * (1 + bufferRatio / leverage)
}

type FlashEvent = { type: 'PUMP' | 'CRASH'; magnitude: number } | null

type ActivePosition = {
  id: string
  marginPhb: number
  entryPrice: number
  leverage: number
  isLong: boolean
  openedAt: string
}

type ExchangeStats = {
  adminPoolPhb: number
  totalLiquidityPhb: number
  totalIssuedPhb: number
  activeMarginPhb: number
}

type CandleShapeProps = {
  x?: number
  y?: number
  width?: number
  height?: number
  value?: [number, number]
  payload?: {
    open?: number
    close?: number
    high?: number
    low?: number
    candleRange?: [number, number]
  }
}

function CandleShape(props: CandleShapeProps) {
  const { x = 0, y = 0, width = 0, height = 0, payload, value } = props
  const candleRange = payload?.candleRange ?? value
  if (!Array.isArray(candleRange) || candleRange.length < 2) return null

  const low = Number(payload?.low ?? candleRange[0])
  const high = Number(payload?.high ?? candleRange[1])
  const open = Number(payload?.open ?? low)
  const close = Number(payload?.close ?? high)
  if (![open, close, high, low].every(Number.isFinite)) return null

  const isUp = close >= open
  const color = isUp ? '#0ecb81' : '#f6465d'
  const priceRange = high - low
  const px = priceRange > 0 ? height / priceRange : 0
  const openY = y + (high - open) * px
  const closeY = y + (high - close) * px
  const bodyTop = Math.min(openY, closeY)
  const bodyBot = Math.max(openY, closeY)

  return (
    <g>
      <line x1={x + width / 2} y1={y} x2={x + width / 2} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={x + 2} y={bodyTop} width={Math.max(width - 4, 1)} height={Math.max(bodyBot - bodyTop, 1)} fill={color} />
    </g>
  )
}

// ─── API 헬퍼 ─────────────────────────────────────────────────────────────────
async function fetchPHBBalance(address: string): Promise<number> {
  const res = await fetch(`/api/phb/balance?address=${address}`, { cache: 'no-store' })
  const data = await res.json()
  return data.phbBalance ?? 0
}

async function fetchOpenPosition(address: string): Promise<ActivePosition | null> {
  const res = await fetch(`/api/trade/position?address=${address}`, { cache: 'no-store' })
  const data = await res.json()
  return data.position ?? null
}

async function fetchHistory(limit = 10): Promise<any[]> {
  const res = await fetch(`/api/trade/history?limit=${limit}`, { cache: 'no-store' })
  const data = await res.json()
  return data.history ?? []
}

async function fetchExchangeStats(): Promise<ExchangeStats> {
  const res = await fetch('/api/exchange/stats', { cache: 'no-store' })
  if (!res.ok) throw new Error('exchange stats fetch failed')
  return res.json()
}

// ─────────────────────────────────────────────────────────────────────────────
export default function Home() {
  const { address, isConnected } = useAccount()
  const { connect, connectors }  = useConnect()
  const { disconnect }           = useDisconnect()

  const isAdmin = useMemo(() => {
    const owner = process.env.NEXT_PUBLIC_OWNER_ADDRESS?.toLowerCase()
    return !!(address && owner && address.toLowerCase() === owner)
  }, [address])

  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  // ─── PHB 상태 ──────────────────────────────────────────────────────────────
  const [phbBalance, setPhbBalance]         = useState<number>(0)
  const [activePosition, setActivePosition] = useState<ActivePosition | null>(null)
  const [tradeHistory, setTradeHistory]     = useState<any[]>([])

  // ─── 충전 관련 ─────────────────────────────────────────────────────────────
  const [depositEthAmount, setDepositEthAmount] = useState('0.001')   // 충전할 ETH
  const [depositStatus, setDepositStatus]       = useState<string>('')
  const depositEthValue = Number(depositEthAmount)
  const depositPhbAmount = Math.round(depositEthValue / ETH_UNIT) * PHB_PER_ETH_UNIT

  const handleDepositAmountChange = (value: string) => {
    const next = Number(value)
    if (Number.isNaN(next)) return
    const clamped = Math.min(DEPOSIT_MAX_ETH, Math.max(DEPOSIT_MIN_ETH, next))
    setDepositEthAmount(clamped.toFixed(3))
  }

  // ─── 인출 관련 ─────────────────────────────────────────────────────────────
  const [withdrawPhbAmount, setWithdrawPhbAmount] = useState('10')
  const [withdrawStatus, setWithdrawStatus]       = useState<string>('')
  const [showWithdraw, setShowWithdraw]           = useState(false)

  // ─── 거래 관련 ─────────────────────────────────────────────────────────────
  const [marginPHB, setMarginPHB]           = useState('10')       // PHB 단위
  const [leverage, setLeverage]             = useState<number>(10)
  const [isLongSelection, setIsLongSelection] = useState<boolean>(true)
  const [tradeStatus, setTradeStatus]       = useState<string>('')
  const [isTrading, setIsTrading]           = useState(false)

  // ─── 청산 알림 ─────────────────────────────────────────────────────────────
  const [liquidationAlert, setLiquidationAlert] = useState(false)
  const liquidatedRef = useRef(false)

  // ─── Flash 이벤트 ──────────────────────────────────────────────────────────
  const [flashEvent, setFlashEvent] = useState<FlashEvent>(null)
  const flashCooldownRef = useRef(0)

  const sessionLoading = false;
  const sessionStatus = { hasAccess: true, expiresAt: null, remainingMs: 0 };

  const [entryStatus, setEntryStatus] = useState('')

  // ─── 거래소 통계 ──────────────────────────────────────────────────
  const [exchangeStats, setExchangeStats] = useState<ExchangeStats | null>(null)


  // 컨트랙트 실제 ETH 잔고 (온체인 실시간 - useBalance 사용으로 더 정확하게)
  const { data: contractBalance, refetch: refetchContractBalance } = useBalance({
    address: PHB_EXCHANGE_ADDRESS,
    query: { refetchInterval: 5000 },
  })
  const contractEthBalance = contractBalance ? Number(contractBalance.value) / 1e18 : 0
  const publicClient = usePublicClient()
  const [isExchangeContract, setIsExchangeContract] = useState<boolean | null>(null)

  useEffect(() => {
    if (!publicClient) return
    let stopped = false
    publicClient
      .getCode({ address: PHB_EXCHANGE_ADDRESS })
      .then(code => {
        if (!stopped) setIsExchangeContract(!!code && code !== '0x')
      })
      .catch(() => {
        if (!stopped) setIsExchangeContract(null)
      })
    return () => {
      stopped = true
    }
  }, [publicClient])

  const [adminStatus, setAdminStatus] = useState('')
  const [liqPhbAmount, setLiqPhbAmount] = useState('100')
  const [isAdminLoading, setIsAdminLoading] = useState(false)
  const adminPanelRef = useRef<HTMLDivElement>(null)
  const isAdminUi = mounted && isAdmin

  const handleGoAdminPanel = () => {
    if (!mounted || !isConnected) {
      alert('관리자 패널은 지갑 연결 후 접근할 수 있습니다.')
      return
    }
    if (!isAdmin) {
      alert('관리자 권한(OWNER)이 필요합니다.')
      return
    }
    adminPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ─── 관리자 핸들러 ───────────────────────────────────────────────────────
  const handleAdminAddLiquidity = async () => {
    if (!address || isAdminLoading) return
    const phbAmount = parseFloat(liqPhbAmount)
    if (isNaN(phbAmount) || phbAmount <= 0) {
      setAdminStatus('❌ 올바른 PHB 수량을 입력하세요.')
      return
    }
    setIsAdminLoading(true)
    setAdminStatus('처리 중...')
    try {
      const res = await fetch('/api/admin/add-liquidity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerAddress: address, phbAmount }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setAdminStatus(`✅ ${phbAmount} PHB 풀 이동 완료!`)
      refreshData()
    } catch (e: any) {
      setAdminStatus(`❌ ${e.message}`)
    } finally {
      setIsAdminLoading(false)
    }
  }

  // 통합 회수 (PHB + ETH)
  const { data: ethWithdrawHash, isPending: isEthWithdrawPending, writeContract: writeEthWithdraw, error: ethWithdrawError } = useWriteContract()
  const { isLoading: isEthWithdrawConfirming, isSuccess: isEthWithdrawConfirmed } = useWaitForTransactionReceipt({ hash: ethWithdrawHash })

  // [관리자] 1. 모든 유동 PHB 회수 (DB만 처리)
  const handleAdminPhbRecovery = async () => {
    if (!address || isAdminLoading) return
    if (!confirm('거래소의 모든 유동 PHB(공급액 + 발행액)를 내 잔고로 회수하시겠습니까?')) return

    setIsAdminLoading(true)
    setAdminStatus('PHB 회수 중...')

    try {
      const res = await fetch('/api/admin/emergency-withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerAddress: address }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      
      setAdminStatus('✅ 모든 PHB를 내 잔고로 성공적으로 회수했습니다!')
      refreshData()
      setTimeout(() => setAdminStatus(''), 5000)
    } catch (e: any) {
      setAdminStatus(`❌ ${e.message}`)
    } finally {
      setIsAdminLoading(false)
    }
  }

  // [관리자] 2. 컨트랙트 ETH 전액 출금 (온체인)
  const handleAdminEthFullWithdraw = async () => {
    if (!address || !publicClient) return
    if (isEthWithdrawPending) return
    if (!confirm('컨트랙트에 쌓인 모든 ETH를 내 지갑으로 즉시 출금하시겠습니까?')) return

    try {
      const code = await publicClient.getCode({ address: PHB_EXCHANGE_ADDRESS })
      if (!code || code === '0x') {
        setAdminStatus('❌ 현재 주소는 컨트랙트가 아닙니다. NEXT_PUBLIC_PHB_EXCHANGE_ADDRESS를 확인하세요.')
        return
      }

      const owner = await publicClient.readContract({
        address: PHB_EXCHANGE_ADDRESS,
        abi: PHB_EXCHANGE_ABI,
        functionName: 'owner',
      })
      if (owner.toLowerCase() !== address.toLowerCase()) {
        setAdminStatus(`❌ owner 불일치: 컨트랙트 owner=${owner.slice(0, 6)}...${owner.slice(-4)}`)
        return
      }
    } catch (e: any) {
      const msg = e?.shortMessage ?? e?.message ?? '컨트랙트 검증 실패'
      setAdminStatus(`❌ ${msg}`)
      return
    }

    writeEthWithdraw({
      address:      PHB_EXCHANGE_ADDRESS,
      abi:          PHB_EXCHANGE_ABI,
      functionName: 'emergencyWithdraw',
    })
  }

  // ETH 회수 TX 성공 후 마무리
  useEffect(() => {
    if (!isEthWithdrawConfirmed || !ethWithdrawHash) return
    setAdminStatus('✅ 컨트랙트 ETH 전액 출금 성공!')
    refreshData()
    setTimeout(() => setAdminStatus(''), 8000)
  }, [isEthWithdrawConfirmed, ethWithdrawHash])

  useEffect(() => {
    if (!ethWithdrawError) return
    const msg = (ethWithdrawError as any).shortMessage ?? ethWithdrawError.message ?? '오류'
    setAdminStatus(`❌ ETH 회수 실패: ${msg}`)
    setIsAdminLoading(false)
  }, [ethWithdrawError])

  // ─── 개인 PHB → ETH 환전 (selfWithdraw) ─────────────────────────
  const { data: adminSelfWithdrawHash, isPending: isAdminSelfWithdrawPending, writeContract: writeAdminSelfWithdraw, error: adminSelfWithdrawError } = useWriteContract()
  const { isLoading: isAdminSelfWithdrawConfirming, isSuccess: isAdminSelfWithdrawConfirmed } = useWaitForTransactionReceipt({ hash: adminSelfWithdrawHash })
  const [ethWithdrawStatus, setEthWithdrawStatus] = useState('')
  const ethWithdrawPhbRef = useRef(0)

  useEffect(() => {
    if (!isAdminSelfWithdrawConfirmed || !adminSelfWithdrawHash || !address) return
    const deducted = ethWithdrawPhbRef.current
    fetch('/api/admin/eth-withdraw-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerAddress: address, phbAmount: deducted }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setPhbBalance(data.phbBalance)
          setEthWithdrawStatus(`✅ ${deducted} PHB → ${(deducted / PHB_PER_ETH_UNIT * ETH_UNIT).toFixed(4)} ETH 지갑 입금 완료!`)
        } else {
          setEthWithdrawStatus(`⚠️ 온체인 성공, DB 오류: ${data.error}`)
        }
        setTimeout(() => setEthWithdrawStatus(''), 8000)
        refreshData()
      })
  }, [isAdminSelfWithdrawConfirmed, adminSelfWithdrawHash, address])

  useEffect(() => {
    if (!adminSelfWithdrawError) return
    const msg = (adminSelfWithdrawError as any).shortMessage ?? adminSelfWithdrawError.message ?? '오류'
    setEthWithdrawStatus(`❌ ${msg.slice(0, 80)}`)
    setTimeout(() => setEthWithdrawStatus(''), 6000)
  }, [adminSelfWithdrawError])

  const handleAdminEthWithdraw = () => {
    if (isAdminLoading || isAdminSelfWithdrawPending) return
    const phbAmount = Math.floor((phbBalance + 1e-9) / PHB_PER_ETH_UNIT) * PHB_PER_ETH_UNIT
    if (phbAmount <= 0) {
      setEthWithdrawStatus('❌ 내 PHB 잔액이 없습니다.')
      return
    }
    const ethExpected = (phbAmount / PHB_PER_ETH_UNIT * ETH_UNIT).toFixed(4)
    if (!confirm(`내 PHB ${phbAmount} PHB → ${ethExpected} ETH로 환전하여 MetaMask로 입금합니다.\n\n진행하시겠습니까?`)) return

    ethWithdrawPhbRef.current = phbAmount
    writeAdminSelfWithdraw({
      address: PHB_EXCHANGE_ADDRESS,
      abi: PHB_EXCHANGE_ABI,
      functionName: 'selfWithdraw',
      args: [BigInt(phbAmount)],
    })
  }

  // DB 초기화
  const [isResetting, setIsResetting] = useState(false)
  const [resetStatus, setResetStatus] = useState('')
  const handleAdminResetDb = async (resetPrice: boolean) => {
    if (!address || isResetting || !confirm('DB를 초기화하시겠습니까?')) return
    setIsResetting(true)
    setResetStatus('초기화 중...')
    try {
      const res = await fetch('/api/admin/reset-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerAddress: address, resetPrice }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResetStatus(`✅ ${data.message}`)
      refreshData()
    } catch (e: any) {
      setResetStatus(`❌ ${e.message}`)
    } finally {
      setIsResetting(false)
    }
  }


  // ─── 공유 가격 데이터 (서버 폴링) ────────────────────────────────────────────
  const [currentPrice, setCurrentPrice] = useState<number>(0.052450)
  const [candles, setCandles]           = useState<any[]>([])
  const [priceConnected, setPriceConnected] = useState(false)  // 서버 연결 상태
  const prevCandleCount = useRef(0)
  const chartScrollRef  = useRef<HTMLDivElement>(null)
  // Flash 이벤트는 가격 변동률로 클라이언트에서 감지
  const prevPriceRef     = useRef(0.052450)


  // 캔들 수가 늘어나면 자동 우측 스크롤
  useEffect(() => {
    if (candles.length > prevCandleCount.current) {
      prevCandleCount.current = candles.length
      if (chartScrollRef.current) {
        chartScrollRef.current.scrollLeft = chartScrollRef.current.scrollWidth
      }
    }
  }, [candles.length])

  // 서버 API 1초 폴링 → 모든 사용자 동일한 차트
  useEffect(() => {
    let stopped = false

    const poll = async () => {
      try {
        const res  = await fetch('/api/price/candles?limit=80', { cache: 'no-store' })
        if (!res.ok) throw new Error('fetch failed')
        const data = await res.json()

        if (stopped) return

        setCurrentPrice(data.currentPrice)
        setCandles(data.candles ?? [])
        setPriceConnected(true)

        // Flash 이벤트 감지 (전 가격 대비 5% 이상 변동)
        const prev = prevPriceRef.current
        if (prev > 0) {
          const changePct = (data.currentPrice - prev) / prev
          if (Math.abs(changePct) >= 0.05 && flashCooldownRef.current <= 0) {
            const isPump = changePct > 0
            setFlashEvent({ type: isPump ? 'PUMP' : 'CRASH', magnitude: Math.round(Math.abs(changePct) * 100) })
            flashCooldownRef.current = 45
            setTimeout(() => setFlashEvent(null), 3500)
          }
        }
        prevPriceRef.current        = data.currentPrice
        flashCooldownRef.current    = Math.max(0, flashCooldownRef.current - 1)
      } catch {
        if (!stopped) setPriceConnected(false)
      }
    }

    poll()  // 즉시 첫 번째 호출
    const interval = setInterval(poll, PRICE_POLL_MS)
    return () => { stopped = true; clearInterval(interval) }
  }, [])

  // 거래소 통계 폴링
  useEffect(() => {
    let stopped = false
    const fetchStats = async () => {
      try {
        const data = await fetchExchangeStats()
        if (!stopped) setExchangeStats(data)
      } catch { /* silent */ }
    }
    fetchStats()
    const interval = setInterval(fetchStats, EXCHANGE_STATS_POLL_MS)
    return () => { stopped = true; clearInterval(interval) }
  }, [])

  // ─── 데이터 새로고침 ────────────────────────────────────────────────────────
  const refreshData = useCallback(async () => {
    if (!address || !mounted) return   // address & mount 이중 방어
    const [balRes, posRes, histRes, statsRes] = await Promise.allSettled([
      fetchPHBBalance(address),
      fetchOpenPosition(address),
      fetchHistory(10),
      fetchExchangeStats(),
    ])

    if (balRes.status === 'fulfilled') {
      setPhbBalance(balRes.value)
    }
    if (posRes.status === 'fulfilled') {
      setActivePosition(posRes.value)
      if (!posRes.value) liquidatedRef.current = false
    }
    if (histRes.status === 'fulfilled') {
      setTradeHistory(histRes.value)
    }
    if (statsRes.status === 'fulfilled') {
      setExchangeStats(statsRes.value)
    }
  }, [address, mounted])

  // 지갑 연결 시 + 주기적 폴링
  useEffect(() => {
    if (!address) return
    refreshData()
    const interval = setInterval(refreshData, ACCOUNT_DATA_POLL_MS)
    return () => clearInterval(interval)
  }, [address, refreshData])

  // ─── 청산가 계산 ────────────────────────────────────────────────────────────
  const liquidationPrice = useMemo(() => {
    if (!activePosition) return null
    return calcLiquidationPrice(activePosition.entryPrice, activePosition.leverage, activePosition.isLong)
  }, [activePosition])

  const previewLiquidationPrice = useMemo(() =>
    calcLiquidationPrice(currentPrice, leverage, isLongSelection),
    [currentPrice, leverage, isLongSelection]
  )

  // ─── 실시간 PnL (PHB 단위) ─────────────────────────────────────────────────
  const pnlData = useMemo(() => {
    if (!activePosition) return { rawPnL: 0, fee: 0, netPnL: 0, isProfit: false, feeRate: 0 }
    const diff      = currentPrice - activePosition.entryPrice
    const directed  = activePosition.isLong ? diff : -diff
    const rawPnL    = (activePosition.marginPhb * activePosition.leverage * directed) / activePosition.entryPrice
    if (rawPnL >= 0) {
      const feeRate = 30 + Math.floor(((activePosition.leverage - 1) * 20) / 99)
      const fee     = rawPnL * (feeRate / 100)
      return { rawPnL, fee, netPnL: rawPnL - fee, isProfit: true, feeRate }
    } else {
      const lossAbs = Math.min(Math.abs(rawPnL), activePosition.marginPhb)
      return { rawPnL: -lossAbs, fee: 0, netPnL: -lossAbs, isProfit: false, feeRate: 0 }
    }
  }, [activePosition, currentPrice])

  const pnlPercent = useMemo(() => {
    if (!activePosition) return 0
    const diff    = (currentPrice - activePosition.entryPrice) / activePosition.entryPrice
    const actual  = activePosition.isLong ? diff : -diff
    const pct     = actual * 100 * activePosition.leverage
    return pct <= -100 ? -100 : pct
  }, [activePosition, currentPrice])

  // ─── 자동 청산 감지 ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!address || !activePosition || !liquidationPrice || liquidatedRef.current) return
    const isLiquidated = activePosition.isLong
      ? currentPrice <= liquidationPrice
      : currentPrice >= liquidationPrice
    if (isLiquidated) {
      liquidatedRef.current = true
      setLiquidationAlert(true)
      setActivePosition(null)
      setTradeStatus('⚠️ 청산가 도달 - 포지션 자동 종료')

      fetch('/api/trade/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, exitPrice: currentPrice }),
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          setPhbBalance(data.phbBalance)
        } else {
          liquidatedRef.current = false
          setActivePosition(activePosition)
          setTradeStatus(`⚠️ 자동 청산 실패: ${data.error}`)
        }
      })
      .catch(() => {
        liquidatedRef.current = false
        setActivePosition(activePosition)
        setTradeStatus('⚠️ 자동 청산 실패: 네트워크 오류')
      })
      .finally(() => {
        refreshData()
        setTimeout(() => setLiquidationAlert(false), 5000)
        setTimeout(() => setTradeStatus(''), 5000)
      })
    }
  }, [currentPrice, activePosition, liquidationPrice, address, refreshData])

  // ─── 컨트랙트 충전 (ETH → PHB) ────────────────────────────────────────────
  const { data: depositHash, isPending: isDepositPending, writeContract: writeDeposit } = useWriteContract()
  const { isLoading: isDepositConfirming, isSuccess: isDepositConfirmed } = useWaitForTransactionReceipt({ hash: depositHash })

  // 충전 확정 시 DB에 PHB 지급 요청
  useEffect(() => {
    if (!isDepositConfirmed || !depositHash || !address) return
    let stopped = false
    const sync = async () => {
      setDepositStatus('PHB 지급 처리 중...')
      for (let i = 0; i < 5; i++) {
        try {
          const res = await fetch('/api/phb/deposit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txHash: depositHash }),
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? '충전 반영 실패')
          if (stopped) return
          setDepositStatus(`✅ ${data.phbAdded} PHB 충전 완료!`)
          setPhbBalance(data.phbBalance)
          refreshData()
          setTimeout(() => setDepositStatus(''), 4000)
          return
        } catch (e: any) {
          if (i === 4) {
            if (!stopped) setDepositStatus(`⚠️ ${e?.message ?? '충전 반영 실패'}`)
            return
          }
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }
    sync()
    return () => {
      stopped = true
    }
  }, [isDepositConfirmed, depositHash, address, refreshData])

  const handleDeposit = () => {
    const eth = parseFloat(depositEthAmount)
    const units = Math.round(eth / ETH_UNIT)
    const isValidStep = Math.abs(eth - units * ETH_UNIT) < 0.0000001
    if (isNaN(eth) || eth < DEPOSIT_MIN_ETH || eth > DEPOSIT_MAX_ETH || !isValidStep) {
      setDepositStatus('⚠️ 0.001~0.05 ETH 범위에서 0.001 ETH 단위로 선택해주세요.')
      return
    }
    setDepositStatus('MetaMask 서명 대기 중...')
    writeDeposit({
      address: PHB_EXCHANGE_ADDRESS,
      abi: PHB_EXCHANGE_ABI,
      functionName: 'depositETH',
      value: parseEther(eth.toFixed(3)),
    })
  }

  // ─── PHB 인출 (MetaMask 직접 서명 → selfWithdraw) ────────────────────────
  const {
    data:       withdrawTxHash,
    isPending:  isWithdrawPending,
    writeContract: writeSelfWithdraw,
    error:      withdrawWriteError,
  } = useWriteContract()

  const { isLoading: isWithdrawConfirming, isSuccess: isWithdrawConfirmed } =
    useWaitForTransactionReceipt({ hash: withdrawTxHash })

  // 저장해둔 인출 PHB 수량 (컨펌 후 DB 차감에 사용)
  const [pendingWithdrawPhb, setPendingWithdrawPhb] = useState<number>(0)

  // 컨펌 완료 → DB PHB 차감
  useEffect(() => {
    if (!isWithdrawConfirmed || !withdrawTxHash || !address || !pendingWithdrawPhb) return
    setWithdrawStatus('✅ 온체인 컨펌 완료! PHB 차감 중...')
    fetch('/api/phb/withdraw/confirm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ address, phbAmount: pendingWithdrawPhb, txHash: withdrawTxHash }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          setPhbBalance(data.newPhbBalance)
          setWithdrawStatus(`✅ 인출 완료! ${pendingWithdrawPhb} PHB → ETH 전송됨`)
          refreshData()
        } else {
          setWithdrawStatus(`⚠️ ${data.error}`)
        }
        setPendingWithdrawPhb(0)
        setTimeout(() => setWithdrawStatus(''), 6000)
      })
      .catch(() => setWithdrawStatus('⚠️ 서버 오류'))
  }, [isWithdrawConfirmed, withdrawTxHash, address, pendingWithdrawPhb, refreshData])

  // writeContract 오류 처리
  useEffect(() => {
    if (!withdrawWriteError) return
    const msg = (withdrawWriteError as any).shortMessage ?? withdrawWriteError.message ?? '오류'
    setWithdrawStatus(`⚠️ ${msg.slice(0, 80)}`)
    setTimeout(() => setWithdrawStatus(''), 6000)
  }, [withdrawWriteError])

  const handleWithdraw = () => {
    const phb = parseInt(withdrawPhbAmount)
    if (!phb || phb % PHB_PER_ETH_UNIT !== 0) {
      setWithdrawStatus('⚠️ 10 PHB 단위로 입력해주세요.')
      return
    }
    if (phb > phbBalance) {
      setWithdrawStatus('⚠️ PHB 잔액이 부족합니다.')
      return
    }
    setPendingWithdrawPhb(phb)
    // MetaMask 팝업 트리거
    writeSelfWithdraw({
      address:      PHB_EXCHANGE_ADDRESS,
      abi:          PHB_EXCHANGE_ABI,
      functionName: 'selfWithdraw',
      args:         [BigInt(phb)],
    })
  }

  // ─── 포지션 오픈 (PHB 차감만, 트랜잭션 없음) ────────────────────────────────
  const handleOpenPosition = async () => {
    const margin = parseFloat(marginPHB)
    if (isNaN(margin) || margin < 1) {
      setTradeStatus('⚠️ 최소 1 PHB 이상 입력해주세요.')
      return
    }
    if (margin > phbBalance) {
      setTradeStatus('⚠️ PHB 잔액이 부족합니다.')
      return
    }
    const optimisticPosition: ActivePosition = {
      id: `pending-${Date.now()}`,
      marginPhb: margin,
      entryPrice: currentPrice,
      leverage,
      isLong: isLongSelection,
      openedAt: new Date().toISOString(),
    }
    const previousBalance = phbBalance
    const previousPosition = activePosition

    setIsTrading(true)
    setTradeStatus(`✅ ${isLongSelection ? 'LONG' : 'SHORT'} 포지션 즉시 진입`)
    setPhbBalance(previousBalance - margin)
    setActivePosition(optimisticPosition)

    try {
      const res = await fetch('/api/trade/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          marginPhb: margin,
          entryPrice: currentPrice,
          leverage,
          isLong: isLongSelection,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setTradeStatus(`✅ ${isLongSelection ? 'LONG' : 'SHORT'} 포지션 오픈!`)
        setPhbBalance(data.phbBalance)
        setActivePosition(data.position)
        refreshData()
      } else {
        setPhbBalance(previousBalance)
        setActivePosition(previousPosition)
        setTradeStatus(`⚠️ ${data.error}`)
      }
    } catch {
      setPhbBalance(previousBalance)
      setActivePosition(previousPosition)
      setTradeStatus('⚠️ 네트워크 오류')
    } finally {
      setIsTrading(false)
      setTimeout(() => setTradeStatus(''), 3000)
    }
  }

  // ─── 포지션 종료 (PHB 정산, 트랜잭션 없음) ──────────────────────────────────
  const handleClosePosition = async () => {
    setIsTrading(true)
    setTradeStatus('포지션 종료 중...')
    try {
      const res = await fetch('/api/trade/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, exitPrice: currentPrice }),
      })
      const data = await res.json()
      if (data.success) {
        const sign = data.pnlPhb >= 0 ? '+' : ''
        setTradeStatus(`✅ 종료 완료! ${sign}${data.pnlPhb?.toFixed(2)} PHB`)
        setPhbBalance(data.phbBalance)
        setActivePosition(null)
        await refreshData()
      } else {
        setTradeStatus(`⚠️ ${data.error}`)
      }
    } catch {
      setTradeStatus('⚠️ 네트워크 오류')
    } finally {
      setIsTrading(false)
      setTimeout(() => setTradeStatus(''), 3000)
    }
  }

  // ─── 차트 도메인 ────────────────────────────────────────────────────────────
  const chartDomain = useMemo(() => {
    if (candles.length === 0) return ['auto', 'auto'] as const
    const allPrices = candles.flatMap((c: any) => [c.high, c.low])
    let minP = Math.min(...allPrices)
    let maxP = Math.max(...allPrices)
    if (liquidationPrice) {
      minP = Math.min(minP, liquidationPrice * 0.999)
      maxP = Math.max(maxP, liquidationPrice * 1.001)
    }
    if (activePosition) {
      minP = Math.min(minP, activePosition.entryPrice * 0.999)
      maxP = Math.max(maxP, activePosition.entryPrice * 1.001)
    }
    const pad = Math.max((maxP - minP) * 0.1, maxP * 0.002)
    return [minP - pad, maxP + pad] as [number, number]
  }, [candles, liquidationPrice, activePosition])

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0b0e11] text-[#eaecef] font-sans selection:bg-[#fcd535]/30 relative">


      {/* ── 청산 플래시 알림 */}
      {liquidationAlert && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[200] animate-bounce">
          <div className="bg-[#f6465d] text-white px-6 py-4 rounded-xl shadow-2xl shadow-[#f6465d]/40 flex items-center gap-3 border border-[#ff7a8a]">
            <AlertTriangle className="w-6 h-6 animate-pulse" />
            <div>
              <p className="font-black text-lg">⚡ 강제 청산 발생!</p>
              <p className="text-sm opacity-90">청산가 도달 — 포지션이 자동 종료되었습니다.</p>
            </div>
          </div>
        </div>
      )}

      {/* ── Flash 이벤트 */}
      {flashEvent && (
        <div className="fixed top-0 left-0 w-full z-[190] pointer-events-none" style={{ animation: 'flashBanner 3.5s ease-out forwards' }}>
          <div className={`w-full py-3 flex items-center justify-center gap-4 ${flashEvent.type === 'PUMP' ? 'bg-gradient-to-r from-[#0ecb81] via-[#12e391] to-[#0ecb81]' : 'bg-gradient-to-r from-[#f6465d] via-[#ff3a50] to-[#f6465d]'}`}>
            <span className="text-2xl">{flashEvent.type === 'PUMP' ? '🚀' : '💥'}</span>
            <div className="text-center">
              <p className="text-black font-black text-xl">{flashEvent.type === 'PUMP' ? '⚡ FLASH PUMP' : '📉 FLASH CRASH'} <span className="text-black/70 text-base">+{flashEvent.magnitude}% 급변동!</span></p>
              <p className="text-black/80 text-xs font-bold">{flashEvent.type === 'PUMP' ? '숏 포지션 청산 위험!' : '롱 포지션 청산 위험!'}</p>
            </div>
            <span className="text-2xl">{flashEvent.type === 'PUMP' ? '🚀' : '💥'}</span>
          </div>
          <div className={`fixed inset-0 pointer-events-none border-4 ${flashEvent.type === 'PUMP' ? 'border-[#0ecb81]' : 'border-[#f6465d]'}`} style={{ animation: 'flashBorder 0.5s ease-out 3 alternate' }} />
        </div>
      )}

      <style>{`
        @keyframes flashBanner { 0%{opacity:1;transform:translateY(0)} 80%{opacity:1;transform:translateY(0)} 100%{opacity:0;transform:translateY(-20px)} }
        @keyframes flashBorder { from{opacity:1} to{opacity:0} }
      `}</style>

      {/* ── GNB */}
      <nav className="h-[60px] border-b border-[#2b3139] bg-[#181a20] px-6 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-[#fcd535] rounded-lg flex items-center justify-center">
              <BarChart3 className="text-black w-5 h-5" />
            </div>
            <span className="text-xl font-bold text-white tracking-tighter">PHB TRADER <span className="text-[#fcd535] text-xs font-mono">PRO</span></span>
          </div>
          <div className="hidden md:flex gap-6 text-sm font-medium text-[#848e9c]">
            <span className="text-[#fcd535] cursor-pointer">거래소</span>
            <button
              type="button"
              onClick={handleGoAdminPanel}
              className={`flex items-center gap-1 transition-colors ${isAdminUi ? 'text-[#f6465d] hover:text-[#ff5b6f]' : 'hover:text-white'}`}
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              관리자
            </button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {/* 거래소 통계 (DB 기반, 누구나 볼 수 있음) */}
          <div className="hidden lg:flex items-center gap-5 border-r border-[#2b3139] pr-4 mr-2">
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-[#848e9c] font-bold flex items-center gap-1">
                <Waves className="w-3 h-3 text-[#0ecb81]" /> PHB LIQUIDITY
              </span>
              <span className="text-sm font-mono text-white font-black">
                {exchangeStats ? exchangeStats.totalLiquidityPhb.toFixed(0) : '...'} PHB
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-[#848e9c] font-bold flex items-center gap-1">
                <Coins className="w-3 h-3 text-[#fcd535]" /> TOTAL PHB
              </span>
              <span className="text-sm font-mono text-[#fcd535] font-black">
                {exchangeStats ? exchangeStats.totalIssuedPhb.toFixed(0) : '...'} PHB
              </span>
              <span className="text-[9px] text-[#848e9c] font-mono">
                {exchangeStats ? exchangeStats.activeMarginPhb.toFixed(0) : '0'} in positions
              </span>
            </div>
          </div>

          {/* PHB 총 자산 표시 (가용 잔고 + 포지션 평가 금액) */}
          {mounted && isConnected && (
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-[10px] text-[#848e9c] font-bold flex items-center gap-1">
                <Coins className="w-3 h-3" /> MY PHB (TOTAL)
              </span>
              <div className="flex items-center gap-2">
                {activePosition && (
                  <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${pnlData.netPnL >= 0 ? 'bg-[#0ecb81]/10 text-[#0ecb81]' : 'bg-[#f6465d]/10 text-[#f6465d]'}`}>
                    {pnlData.netPnL >= 0 ? '+' : ''}{pnlData.netPnL.toFixed(2)}
                  </span>
                )}
                <span className="text-sm font-mono text-[#fcd535] font-black">
                  {(phbBalance + (activePosition ? (activePosition.marginPhb + pnlData.netPnL) : 0)).toFixed(2)} PHB
                </span>
              </div>
            </div>
          )}
          {mounted && isConnected ? (
            <div className="flex flex-col items-end gap-0.5">
              <button onClick={() => disconnect()} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all border ${isAdmin ? 'bg-[#f6465d]/10 border-[#f6465d] text-[#f6465d]' : 'bg-[#2b3139] hover:bg-[#363c44] border-[#474d57]'}`}>
                {isAdmin ? <ShieldAlert className="w-4 h-4" /> : <Wallet className="w-4 h-4 text-[#fcd535]" />}
                <span className="font-mono text-xs">{address?.slice(0, 6)}...{address?.slice(-4)}</span>
                {isAdmin && <span className="text-[9px] font-black uppercase ml-1">Admin</span>}
                <LogOut className="w-3 h-3 ml-1 opacity-50" />
              </button>
            </div>
          ) : (
            <button onClick={() => connect({ connector: connectors[0] })} className="bg-[#fcd535] hover:bg-[#f2c94c] text-black px-6 py-2 rounded-lg text-sm font-bold transition-all">
              지갑 연결
            </button>
          )}
        </div>
      </nav>

      <main className="max-w-[1400px] mx-auto p-4 grid grid-cols-12 gap-4">

        {/* ── Left: 차트 + 기록 */}
        <div className="col-span-12 lg:col-span-8 flex flex-col gap-4">

          {/* 차트 패널 */}
          <div className="bg-[#181a20] rounded-xl p-6 border border-[#2b3139]">
            <div className="flex justify-between items-center mb-6">
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#848e9c] font-bold uppercase tracking-widest">SepoliaETH Index (Real-time)</span>
                  {priceConnected && (
                    <span className="text-[9px] bg-[#0ecb81]/10 text-[#0ecb81] border border-[#0ecb81]/30 px-1.5 py-0.5 rounded font-bold flex items-center gap-1">
                      <Signal className="w-2.5 h-2.5" /> 공유 서버 차트
                    </span>
                  )}
                  {!priceConnected && (
                    <span className="text-[9px] bg-[#fcd535]/10 text-[#fcd535] border border-[#fcd535]/30 px-1.5 py-0.5 rounded font-bold animate-pulse">
                      서버 연결 중...
                    </span>
                  )}
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-black text-white font-mono">{currentPrice.toFixed(6)} ETH</span>
                  <span className={`text-sm font-bold ${currentPrice >= 0.052450 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                    {currentPrice >= 0.052450 ? '▲' : '▼'} {Math.abs(((currentPrice - 0.052450) / 0.052450) * 100).toFixed(2)}%
                  </span>
                </div>
                {activePosition && liquidationPrice && (
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] font-bold text-[#f6465d] bg-[#f6465d]/10 px-2 py-0.5 rounded border border-[#f6465d]/30 flex items-center gap-1">
                      <Zap className="w-3 h-3" /> 청산가: {liquidationPrice.toFixed(6)} ETH
                    </span>
                    <span className="text-[10px] text-[#848e9c]">({((Math.abs(currentPrice - liquidationPrice) / currentPrice) * 100).toFixed(2)}% 거리)</span>
                  </div>
                )}
              </div>
            </div>

            <div ref={chartScrollRef} style={{ height: '400px', width: '100%', overflowX: 'auto', overflowY: 'hidden' }}>
              <div style={{ height: '100%', minWidth: '100%', width: `${Math.max(100, (candles.length / 40) * 100)}%` }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={candles} margin={{ top: 20, right: 30, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2b3139" vertical={false} opacity={0.3} />
                    <XAxis dataKey="time" stroke="#5e6673" fontSize={10} tickLine={false} axisLine={false} minTickGap={30} />
                    <YAxis domain={chartDomain} stroke="#5e6673" fontSize={10} tickLine={false} axisLine={false} orientation="right" tickFormatter={v => v.toFixed(5)} />
                    <Tooltip contentStyle={{ backgroundColor: '#1e2329', border: '1px solid #2b3139', borderRadius: '8px', fontSize: '12px' }} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                    {activePosition && liquidationPrice && (
                      <ReferenceLine y={liquidationPrice} stroke="#f6465d" strokeDasharray="6 3" strokeWidth={1.5}
                        label={{ value: `⚡ 청산가 ${liquidationPrice.toFixed(5)}`, position: 'insideTopLeft', fill: '#f6465d', fontSize: 10, fontWeight: 700 }} />
                    )}
                    {activePosition && (
                      <ReferenceLine y={activePosition.entryPrice} stroke={activePosition.isLong ? '#0ecb81' : '#f6465d'} strokeWidth={2}
                        label={{ value: `● 진입가 ${activePosition.entryPrice.toFixed(6)} (${activePosition.isLong ? 'LONG' : 'SHORT'})`, position: 'insideBottomLeft', fill: activePosition.isLong ? '#0ecb81' : '#f6465d', fontSize: 11, fontWeight: 700 }} />
                    )}
                    <Bar dataKey="candleRange" shape={<CandleShape />} animationDuration={0} isAnimationActive={false}>
                      {candles.map((e, i) => (
                        <Cell key={i} fill={e.close >= e.open ? '#0ecb81' : '#f6465d'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* 거래 기록 */}
          <div className="bg-[#181a20] rounded-xl border border-[#2b3139] overflow-hidden">
            <div className="px-6 py-4 border-b border-[#2b3139] flex items-center justify-between">
              <h3 className="font-bold flex items-center gap-2">
                <Clock className="w-4 h-4 text-[#fcd535]" /> 최근 거래 기록 (PHB 단위)
              </h3>
              <button onClick={refreshData} className="text-[#848e9c] hover:text-white transition-colors">
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-[#848e9c] text-[11px] uppercase border-b border-[#2b3139]">
                    <th className="px-4 py-3 font-bold">주소</th>
                    <th className="px-4 py-3 font-bold">증거금 / 방향</th>
                    <th className="px-4 py-3 font-bold">진입가</th>
                    <th className="px-4 py-3 font-bold text-center">종료가</th>
                    <th className="px-4 py-3 font-bold text-right">손익 (PHB)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2b3139]">
                  {tradeHistory.map((h, i) => {
                    const pnl = h.pnlPhb ?? 0
                    return (
                      <tr key={i} className="hover:bg-[#2b3139]/30 transition-colors">
                        <td className="px-4 py-4 font-mono text-[#848e9c] text-xs">{h.userAddress?.slice(0, 6)}...{h.userAddress?.slice(-4)}</td>
                        <td className="px-4 py-4">
                          <span className="block font-bold text-white text-xs">{h.marginPhb?.toFixed(1)} PHB</span>
                          <div className="flex items-center gap-1 mt-0.5">
                            <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${h.isLong ? 'bg-[#0ecb81]/20 text-[#0ecb81]' : 'bg-[#f6465d]/20 text-[#f6465d]'}`}>{h.isLong ? 'LONG' : 'SHORT'}</span>
                            <span className="text-[10px] text-[#848e9c]">{h.leverage}X</span>
                          </div>
                        </td>
                        <td className="px-4 py-4 font-mono text-xs text-white">{h.entryPrice?.toFixed(6)}</td>
                        <td className="px-4 py-4 font-mono text-xs text-white text-center">{h.exitPrice?.toFixed(6) ?? '-'}</td>
                        <td className={`px-4 py-4 text-right font-bold text-sm ${h.isProfit ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                          {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} PHB
                        </td>
                      </tr>
                    )
                  })}
                  {tradeHistory.length === 0 && (
                    <tr><td colSpan={5} className="px-6 py-12 text-center text-[#474d57]">거래 내역이 없습니다. 첫 포지션을 오픈해 보세요!</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ── Right: 트레이딩 패널 */}
        <div className="col-span-12 lg:col-span-4 flex flex-col gap-4">

          {/* 관리자 전용 기능 (mounted 필수: Hydration mismatch 방지) */}
          {mounted && isAdmin && (
            <div ref={adminPanelRef} id="admin-panel" className="bg-[#181a20] rounded-xl p-5 border border-[#f6465d]/50">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-black text-[#f6465d] flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4" /> ADMIN PANEL
                </span>
                <span className="bg-[#f6465d]/20 text-[#f6465d] text-[9px] font-bold px-2 py-1 rounded">OWNER</span>
              </div>

              {/* 현재 풀 상태 요약 */}
              <div className="bg-[#0b0e11] rounded-lg p-3 mb-3 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-[#848e9c]">내가 공급한 PHB</span>
                  <span className="text-[#0ecb81] font-mono font-bold">{exchangeStats?.adminPoolPhb.toFixed(0) ?? '...'} PHB</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#848e9c]">전체 발행 PHB</span>
                  <span className="text-[#fcd535] font-mono font-bold">{exchangeStats?.totalIssuedPhb.toFixed(0) ?? '...'} PHB</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#848e9c]">포지션 사용 PHB</span>
                  <span className="text-white font-mono font-bold">{exchangeStats?.activeMarginPhb.toFixed(0) ?? '0'} PHB</span>
                </div>
                <div className="flex justify-between border-t border-[#2b3139] pt-1">
                  <span className="text-white font-bold">총 거래소 유동성</span>
                  <span className="text-white font-mono font-black">{exchangeStats?.totalLiquidityPhb.toFixed(0) ?? '...'} PHB</span>
                </div>
                {/* 온체인 컨트랙트 실제 ETH 잔고 */}
                <div className="flex flex-col border-t border-[#2b3139] pt-2 pb-1">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[#848e9c] flex items-center gap-1">
                      🔗 컨트랙트 ETH 잔고 <span className="text-[9px] opacity-60">(온체인)</span>
                      <RefreshCw 
                        className="w-3 h-3 cursor-pointer hover:text-white transition-colors" 
                        onClick={() => {
                          refetchContractBalance();
                          setAdminStatus('🔄 잔고 새로고침 중...');
                          setTimeout(() => setAdminStatus(''), 2000);
                        }}
                      />
                    </span>
                    <span className={`font-mono font-black text-sm ${isExchangeContract === false ? 'text-[#f6465d]' : contractEthBalance > 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {contractEthBalance.toFixed(4)} ETH
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="text-[#848e9c]">주소: {PHB_EXCHANGE_ADDRESS.slice(0, 6)}...{PHB_EXCHANGE_ADDRESS.slice(-4)}</span>
                    <button 
                      onClick={() => {
                        navigator.clipboard.writeText(PHB_EXCHANGE_ADDRESS);
                        alert('컨트랙트 주소가 복사되었습니다.');
                      }}
                      className="text-[#fcd535] hover:underline"
                    >
                      주소 복사
                    </button>
                  </div>
                </div>
                {contractEthBalance === 0 && (
                  <p className="text-[9px] text-[#f6465d] text-right">
                    ⚠️ 컨트랙트 ETH 없음 — 사용자 인출 불가
                  </p>
                )}
                {isExchangeContract === false && (
                  <p className="text-[10px] text-[#f6465d] text-right font-bold">
                    ⚠️ 현재 주소는 스마트컨트랙트가 아닙니다(EOA).
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-[10px] text-[#848e9c]">내 PHB 잔고: <span className="text-[#fcd535] font-bold">{phbBalance.toFixed(2)} PHB</span></p>
                <div className="flex gap-2">
                  <input type="number" step="100" min="1"
                    value={liqPhbAmount} onChange={e => setLiqPhbAmount(e.target.value)}
                    className="flex-1 bg-[#0b0e11] text-white text-sm font-bold px-3 py-2 rounded border border-[#2b3139] outline-none"
                    placeholder="PHB 수량" />
                  <button
                    disabled={isAdminLoading}
                    onClick={handleAdminAddLiquidity}
                    className="bg-[#0ecb81]/20 text-[#0ecb81] border border-[#0ecb81]/50 hover:bg-[#0ecb81]/30 font-bold px-3 py-2 text-xs rounded transition whitespace-nowrap disabled:opacity-50">
                    풀에 추가
                  </button>
                </div>
                {adminStatus && (
                  <p className={`text-xs text-center font-bold mt-1 ${adminStatus.startsWith('✅') ? 'text-[#0ecb81]' : adminStatus.startsWith('❌') ? 'text-[#f6465d]' : 'text-[#fcd535] animate-pulse'}`}>
                    {adminStatus}
                  </p>
                )}

                {/* 1. PHB 회수 버튼 */}
                <div className="border-t border-[#fcd535]/30 pt-3 mt-1">
                  <p className="text-[10px] text-[#fcd535] mb-2 font-bold">1️⃣ 모든 유동 PHB 회수 (DB 잔고 이동)</p>
                  <button
                    disabled={isAdminLoading}
                    onClick={handleAdminPhbRecovery}
                    className="w-full bg-[#fcd535] hover:bg-[#ffea00] text-black font-black py-3 rounded-lg text-xs transition flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-[#fcd535]/20"
                  >
                    {isAdminLoading ? (
                      <><Clock className="animate-spin w-4 h-4" /> 회수 진행 중...</>
                    ) : (
                      <><Waves className="w-4 h-4" /> 모든 유동 PHB를 내 잔고로 회수</>
                    )}
                  </button>
                </div>

                {/* 2. 컨트랙트 ETH 출금 버튼 */}
                <div className="border-t border-[#f6465d]/30 pt-4 mt-1">
                  <p className="text-[10px] text-[#f6465d] mb-2 font-bold">2️⃣ 컨트랙트 모든 ETH 내 지갑으로 출금 (온체인)</p>
                  
                  <button
                    disabled={isEthWithdrawPending || isEthWithdrawConfirming}
                    onClick={handleAdminEthFullWithdraw}
                    className="w-full bg-[#f6465d] hover:bg-[#ff3a50] text-white font-black py-4 rounded-xl text-sm transition flex items-center justify-center gap-2 shadow-xl shadow-[#f6465d]/20 animate-pulse-slow"
                  >
                    {isEthWithdrawPending ? (
                      <><Clock className="animate-spin w-5 h-5" /> MetaMask 서명 대기...</>
                    ) : isEthWithdrawConfirming ? (
                      <><Clock className="animate-spin w-5 h-5" /> 블록 컨펌 대기 (출금중)...</>
                    ) : (
                      <><ArrowUpFromLine className="w-5 h-5" /> 컨트랙트 모든 ETH 출금</>
                    )}
                  </button>

                  {ethWithdrawStatus && (
                    <p className={`text-xs text-center font-bold mt-1 ${ethWithdrawStatus.startsWith('✅') ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {ethWithdrawStatus}
                    </p>
                  )}
                </div>

                {/* DB 초기화 */}
                <div className="border-t border-[#f6465d]/30 pt-3 mt-1">
                  <p className="text-[10px] text-[#f6465d] mb-2 font-bold">⚠️ 위험 구역 — DB 초기화</p>
                  <div className="flex gap-2">
                    <button
                      disabled={isResetting}
                      onClick={() => handleAdminResetDb(false)}
                      className="flex-1 bg-[#f6465d]/10 hover:bg-[#f6465d]/20 border border-[#f6465d]/50 text-[#f6465d] font-bold py-2 rounded-lg text-[10px] transition disabled:opacity-50"
                    >
                      {isResetting ? '초기화 중...' : '유저·포지션 초기화\n(가격 유지)'}
                    </button>
                    <button
                      disabled={isResetting}
                      onClick={() => handleAdminResetDb(true)}
                      className="flex-1 bg-[#f6465d]/20 hover:bg-[#f6465d]/40 border border-[#f6465d] text-[#f6465d] font-bold py-2 rounded-lg text-[10px] transition disabled:opacity-50"
                    >
                      {isResetting ? '초기화 중...' : '전체 완전 초기화\n(가격 포함)'}
                    </button>
                  </div>
                  {resetStatus && (
                    <p className={`text-xs text-center font-bold mt-1 ${resetStatus.startsWith('✅') ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {resetStatus}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}



          {/* PHB 충전 카드 */}
          {mounted && isConnected && (
            <div className="bg-[#181a20] rounded-xl p-5 border border-[#2b3139] border-t-4 border-t-[#fcd535]">
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-black text-[#fcd535] flex items-center gap-1.5">
                  <Coins className="w-4 h-4" /> PHB 충전소
                </span>
                <div className="flex items-center gap-1.5 bg-[#2b3139] px-2 py-1 rounded-lg">
                  <Coins className="w-3 h-3 text-[#fcd535]" />
                  <span className="text-xs font-black text-white">{phbBalance.toFixed(2)} PHB</span>
                </div>
              </div>

              {/* 환율 안내 */}
              <div className="bg-[#0b0e11] rounded-lg p-3 mb-4 flex items-center justify-between">
                <div className="text-center">
                  <p className="text-[10px] text-[#848e9c]">입금</p>
                  <p className="text-sm font-black text-white">{depositEthAmount} ETH</p>
                </div>
                <ArrowRightLeft className="w-4 h-4 text-[#fcd535]" />
                <div className="text-center">
                  <p className="text-[10px] text-[#848e9c]">지급</p>
                  <p className="text-sm font-black text-[#fcd535]">{depositPhbAmount} PHB</p>
                </div>
              </div>

              {/* 충전 입력 */}
              <div className="mb-4 rounded-lg bg-[#0b0e11] border border-[#2b3139] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-[#848e9c] font-bold">충전 수량</span>
                  <span className="text-xs font-mono font-black text-[#fcd535]">{depositEthAmount} ETH</span>
                </div>
                <input
                  type="range"
                  min={DEPOSIT_MIN_ETH}
                  max={DEPOSIT_MAX_ETH}
                  step={DEPOSIT_STEP_ETH}
                  value={depositEthAmount}
                  onChange={e => handleDepositAmountChange(e.target.value)}
                  className="w-full accent-[#fcd535]"
                />
                <div className="flex justify-between text-[9px] text-[#848e9c] mt-1 font-mono">
                  <span>{DEPOSIT_MIN_ETH.toFixed(3)}</span>
                  <span>{DEPOSIT_MAX_ETH.toFixed(3)}</span>
                </div>
              </div>

              <button
                onClick={handleDeposit}
                disabled={isDepositPending || isDepositConfirming}
                className="w-full bg-[#fcd535] hover:bg-[#f2c94c] text-black font-black py-3 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isDepositPending || isDepositConfirming
                  ? <Clock className="animate-spin w-4 h-4" />
                  : <ArrowDownToLine className="w-4 h-4" />
                }
                {isDepositPending ? 'MetaMask 서명 대기...' : isDepositConfirming ? '블록 확인 중...' : `${depositEthAmount} ETH → PHB 충전`}
              </button>

              {depositStatus && (
                <p className={`text-xs text-center mt-2 font-bold ${depositStatus.startsWith('✅') ? 'text-[#0ecb81]' : 'text-[#fcd535]'}`}>
                  {depositStatus}
                </p>
              )}

              {/* 인출 토글 */}
              <button onClick={() => setShowWithdraw(!showWithdraw)}
                className="w-full mt-3 text-[10px] text-[#848e9c] hover:text-white flex items-center justify-center gap-1 transition-colors">
                <ArrowUpFromLine className="w-3 h-3" />
                PHB → ETH 인출 {showWithdraw ? '▲' : '▼'}
              </button>

              {showWithdraw && (
                <div className="mt-3 space-y-2 border-t border-[#2b3139] pt-3">
                  <div className="bg-[#2b3139] p-2 rounded-lg flex items-center gap-2">
                    <input type="number" step="10" min="10" value={withdrawPhbAmount}
                      onChange={e => setWithdrawPhbAmount(e.target.value)}
                      className="bg-transparent text-sm font-bold text-white outline-none w-full"
                      placeholder="10" />
                    <span className="text-xs text-[#fcd535] font-bold whitespace-nowrap">PHB</span>
                  </div>
                  <p className="text-[10px] text-[#848e9c] text-right">
                    ≈ {(parseInt(withdrawPhbAmount || '0') / PHB_PER_ETH_UNIT * ETH_UNIT).toFixed(4)} ETH 수령 예상
                  </p>
                  <button
                    onClick={handleWithdraw}
                    disabled={isWithdrawPending || isWithdrawConfirming}
                    className="w-full border border-[#f6465d] text-[#f6465d] hover:bg-[#f6465d]/10 py-2 rounded-lg text-xs font-bold transition disabled:opacity-50 flex items-center justify-center gap-1"
                  >
                    {isWithdrawPending ? (
                      <><Clock className="animate-spin w-3 h-3" /> MetaMask 서명 대기...</>
                    ) : isWithdrawConfirming ? (
                      <><Clock className="animate-spin w-3 h-3" /> 블록 컨펌 대기...</>
                    ) : (
                      'PHB → ETH 인출'
                    )}
                  </button>
                  {withdrawStatus && (
                    <p className={`text-xs text-center font-bold ${withdrawStatus.startsWith('✅') ? 'text-[#0ecb81]' : 'text-[#fcd535]'}`}>
                      {withdrawStatus}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 활성 포지션 */}
          <div className={`bg-[#181a20] rounded-xl p-6 border border-[#2b3139] border-l-4 ${activePosition ? (activePosition.isLong ? 'border-l-[#0ecb81]' : 'border-l-[#f6465d]') : 'border-l-[#fcd535]'}`}>
            <span className={`text-[10px] font-black uppercase tracking-tighter ${activePosition ? (activePosition.isLong ? 'text-[#0ecb81]' : 'text-[#f6465d]') : 'text-[#fcd535]'}`}>
              MY ACTIVE POSITION {activePosition && (activePosition.isLong ? '(LONG)' : '(SHORT)')}
            </span>

            {activePosition ? (
              <div className="mt-4 space-y-3">
                <div className="flex justify-between items-baseline">
                  <div className="flex flex-col">
                    <span className={`text-3xl font-black font-mono ${pnlPercent >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(2)}%
                    </span>
                    <span className="text-xs text-[#848e9c]">실시간 수익률</span>
                  </div>
                  <div className="text-right">
                    <span className={`text-lg font-bold font-mono ${pnlData.netPnL >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {pnlData.netPnL >= 0 ? '+' : ''}{pnlData.netPnL.toFixed(2)} PHB
                    </span>
                    <p className="text-[10px] text-[#848e9c]">Net PnL (수수료 후)</p>
                  </div>
                </div>

                <div className="bg-[#0b0e11] rounded-lg p-3 space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-[#848e9c]">증거금</span>
                    <span className="text-white font-mono font-bold">{activePosition.marginPhb.toFixed(1)} PHB ({activePosition.leverage}X)</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-[#848e9c]">진입가</span>
                    <span className="text-white font-mono">{activePosition.entryPrice.toFixed(6)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-[#848e9c]">총 손익 (Gross)</span>
                    <span className={`font-bold font-mono ${pnlData.rawPnL >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {pnlData.rawPnL >= 0 ? '+' : ''}{pnlData.rawPnL.toFixed(2)} PHB
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-[#848e9c]">수수료 ({pnlData.feeRate}%)</span>
                    <span className="text-[#fcd535] font-mono">-{pnlData.fee.toFixed(2)} PHB</span>
                  </div>
                  <div className="border-t border-[#2b3139] pt-1.5 flex justify-between text-xs">
                    <span className="text-white font-bold">실수령 (Net)</span>
                    <span className={`font-black font-mono ${pnlData.netPnL >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {pnlData.netPnL >= 0 ? '+' : ''}{pnlData.netPnL.toFixed(2)} PHB
                    </span>
                  </div>
                </div>

                {liquidationPrice && (
                  <div className="bg-[#1a0a0c] border border-[#f6465d]/30 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] text-[#f6465d] font-black flex items-center gap-1"><Zap className="w-3 h-3" /> 강제 청산가</span>
                      <span className="text-xs font-bold font-mono text-[#f6465d]">{liquidationPrice.toFixed(6)} ETH</span>
                    </div>
                    {(() => {
                      const dist = Math.abs(currentPrice - liquidationPrice)
                      const distPct = (dist / currentPrice) * 100
                      const danger = Math.max(0, Math.min(100, 100 - distPct * 10))
                      const barColor = danger > 70 ? '#f6465d' : danger > 40 ? '#fcd535' : '#0ecb81'
                      return (
                        <div>
                          <div className="w-full bg-[#2b3139] rounded-full h-1.5 mb-1">
                            <div className="h-1.5 rounded-full transition-all duration-500" style={{ width: `${danger}%`, backgroundColor: barColor }} />
                          </div>
                          <div className="flex justify-between text-[9px] text-[#848e9c]">
                            <span>청산까지 {distPct.toFixed(2)}% 남음</span>
                            <span style={{ color: barColor }} className="font-bold">{danger > 70 ? '⚠️ 매우 위험' : danger > 40 ? '주의 요망' : '안전'}</span>
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )}

                {tradeStatus && (
                  <p className={`text-xs text-center font-bold ${tradeStatus.startsWith('✅') ? 'text-[#0ecb81]' : 'text-[#fcd535]'}`}>{tradeStatus}</p>
                )}

                <button
                  onClick={handleClosePosition}
                  disabled={isTrading}
                  className="w-full bg-[#f6465d] hover:bg-[#ff5b6f] text-white py-3 rounded-lg font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isTrading ? <Clock className="animate-spin w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  시세 차익 실현 및 종료
                </button>
              </div>
            ) : (
              <div className="py-8 flex flex-col items-center gap-3">
                <div className="w-12 h-12 bg-[#2b3139] rounded-full flex items-center justify-center">
                  <BarChart3 className="text-[#474d57] w-6 h-6" />
                </div>
                <p className="text-sm text-[#848e9c]">활성 포지션이 없습니다.</p>
              </div>
            )}
          </div>

          {/* 거래 입력 패널 */}
          {!activePosition && (
            <div className="bg-[#181a20] rounded-xl border border-[#2b3139] overflow-hidden">
              <div className="grid grid-cols-2">
                <button onClick={() => setIsLongSelection(true)}
                  className={`py-3 text-sm font-bold transition-colors ${isLongSelection ? 'bg-[#2b3139] text-[#0ecb81] border-b-2 border-b-[#0ecb81]' : 'text-[#848e9c]'}`}>
                  롱 (상승베팅)
                </button>
                <button onClick={() => setIsLongSelection(false)}
                  className={`py-3 text-sm font-bold transition-colors ${!isLongSelection ? 'bg-[#2b3139] text-[#f6465d] border-b-2 border-b-[#f6465d]' : 'text-[#848e9c]'}`}>
                  숏 (하락베팅)
                </button>
              </div>
              <div className="p-6 space-y-5">
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-[#848e9c] font-bold">투자 수량(Margin)</span>
                    <span className="text-[10px] text-[#fcd535] font-bold">잔액: {phbBalance.toFixed(2)} PHB</span>
                  </div>
                  <div className="bg-[#2b3139] p-3 rounded-lg flex justify-between items-center border border-transparent focus-within:border-[#fcd535] transition-all">
                    <div className="flex items-center gap-2">
                      <Coins className="w-4 h-4 text-[#848e9c]" />
                      <input type="number" step="1" min="1" value={marginPHB}
                        onChange={e => setMarginPHB(e.target.value)}
                        className="bg-transparent text-sm font-bold text-white outline-none w-full"
                        placeholder="10" />
                    </div>
                    <span className="text-xs font-bold text-[#fcd535]">PHB</span>
                  </div>
                  {/* 빠른 입력 버튼 */}
                  <div className="flex gap-1">
                    {[10, 25, 50, 100].map(v => (
                      <button key={v} onClick={() => setMarginPHB(String(Math.min(v, Math.floor(phbBalance))))}
                        className="flex-1 py-1 text-[10px] font-bold rounded bg-[#2b3139] text-[#848e9c] hover:bg-[#363c44] transition-all">
                        {v}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-[#848e9c] font-bold">레버리지</span>
                    <span className="text-[10px] text-[#fcd535]">{leverage}X</span>
                  </div>
                  <div className="flex gap-2">
                    {[1, 10, 50, 100].map(val => (
                      <button key={val} onClick={() => setLeverage(val)}
                        className={`flex-1 py-1 text-xs font-bold rounded transition-all ${leverage === val ? 'bg-[#fcd535] text-black shadow-lg' : 'bg-[#2b3139] text-[#848e9c]'}`}>
                        {val}X
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] text-right text-[#848e9c]">수익 수수료율: <span className="text-[#f6465d]">{30 + Math.floor(((leverage - 1) * 20) / 99)}%</span></p>
                </div>

                {/* 포지션 미리보기 */}
                <div className="bg-[#0b0e11] p-3 rounded-lg space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-[#848e9c]">진입가 예상</span>
                    <span className="text-white font-mono">{currentPrice.toFixed(6)} ETH</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-[#848e9c]">예상 청산가</span>
                    <span className="text-[#f6465d] font-mono font-bold">{previewLiquidationPrice.toFixed(6)} ETH</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-[#848e9c]">청산까지 거리</span>
                    <span className={`font-bold ${leverage >= 50 ? 'text-[#f6465d]' : leverage >= 10 ? 'text-[#fcd535]' : 'text-[#0ecb81]'}`}>
                      {((Math.abs(currentPrice - previewLiquidationPrice) / currentPrice) * 100).toFixed(2)}%&nbsp;
                      ({leverage >= 50 ? '매우 위험' : leverage >= 10 ? '중간' : '안전'})
                    </span>
                  </div>
                  <div className="flex justify-between text-xs border-t border-[#2b3139] pt-1.5">
                    <span className="text-[#848e9c]">트랜잭션</span>
                    <span className="text-[#0ecb81] font-bold">⚡ 즉시 처리 (딜레이 없음)</span>
                  </div>
                </div>

                {tradeStatus && (
                  <p className={`text-xs text-center font-bold ${tradeStatus.startsWith('✅') ? 'text-[#0ecb81]' : 'text-[#fcd535]'}`}>{tradeStatus}</p>
                )}

                <button
                  onClick={handleOpenPosition}
                  disabled={!mounted || isTrading || !isConnected || phbBalance < parseFloat(marginPHB || '0')}
                  className={`w-full text-white font-black py-4 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${isLongSelection ? 'bg-[#0ecb81] hover:bg-[#12e391]' : 'bg-[#f6465d] hover:bg-[#ff5b6f]'}`}
                >
                  {isTrading ? <Clock className="animate-spin w-5 h-5" /> : (isLongSelection ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />)}
                  {isLongSelection ? '상승 포지션 진입 (LONG)' : '하락 포지션 진입 (SHORT)'}
                </button>

                {!mounted || !isConnected ? (
                  <p className="text-[10px] text-[#f6465d] text-center font-bold animate-pulse">지갑을 먼저 연결해 주세요!</p>
                ) : phbBalance === 0 ? (
                  <p className="text-[10px] text-[#fcd535] text-center font-bold">PHB를 먼저 충전해주세요! (0.001 ETH → 10 PHB)</p>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="h-[30px] bg-[#181a20] border-t border-[#2b3139] px-4 flex items-center justify-between text-[10px] text-[#848e9c] fixed bottom-0 w-full z-50">
        <div className="flex gap-4 items-center">
          <span className="flex items-center gap-1">
            <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${priceConnected ? 'bg-[#0ecb81]' : 'bg-[#f6465d]'}`} />
            서버 상태: {priceConnected ? '정상' : '연결 중...'}
          </span>
          <span className="flex items-center gap-1">
            <Signal className="w-3 h-3" />
            공유 차트: {priceConnected ? '실시간 동기화 중' : '대기'}
          </span>
          <span className="text-[#fcd535]">Sepolia Testnet · PHB 내부코인 시스템</span>
        </div>
        <div>© 2026 PHB Trader Pro v3.0 - Blockchain Middle Test</div>
      </footer>
    </div>
  )
}
