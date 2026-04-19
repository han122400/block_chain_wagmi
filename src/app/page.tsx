'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useAccount, useConnect, useDisconnect, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { formatEther, parseEther } from 'viem'
import { TIPJAR_ABI, TIPJAR_ADDRESS } from '@/config/contract'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'
import { Wallet, LogOut, TrendingUp, TrendingDown, Clock, ArrowRightLeft, Wallet2, BarChart3, Key, ArrowRight, AlertTriangle, Zap } from 'lucide-react'

// ─── 청산가 공식 (MAXIMUM HARD MODE) ─────────────────────────────────────────
// MMR = 0.50 → 증거금의 50% 소진하면 바로 청산
// bufferRatio = 0.50
//   LONG  10x: liqPrice = entry × (1 - 0.50/10)  = entry × 0.95  → 5% 하락 시 청산
//   LONG  50x: liqPrice = entry × (1 - 0.50/50)  = entry × 0.99  → 1% 하락 시 청산
//   LONG 100x: liqPrice = entry × (1 - 0.50/100) = entry × 0.995 → 0.5% 하락 시 청산
// 변동폭이 ±10%/틱이므로 대부분의 포지션이 수 초 내 청산됨
const MAINTENANCE_MARGIN_RATE = 0.50; // 유지증거금률 50% (극한 모드)

function calcLiquidationPrice(entryPrice: number, leverage: number, isLong: boolean): number {
  const bufferRatio = 1 - MAINTENANCE_MARGIN_RATE; // 0.50
  if (isLong) {
    return entryPrice * (1 - bufferRatio / leverage);
  } else {
    return entryPrice * (1 + bufferRatio / leverage);
  }
}


// Flash 이벤트 타입
type FlashEvent = { type: 'PUMP' | 'CRASH'; magnitude: number } | null;

export default function Home() {
  const { address, isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()

  // 하이드레이션 에러 방지용 mounted 상태
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  // 청산 플래시 알림 상태
  const [liquidationAlert, setLiquidationAlert] = useState(false)
  const liquidatedRef = useRef(false) // 중복 청산 방지

  // 가격 급등락 Flash 이벤트
  const [flashEvent, setFlashEvent] = useState<FlashEvent>(null)
  const flashCooldownRef = useRef(0) // Flash 이벤트 쿨타임 (틱 단위)

  // ─── localStorage 키 상수 ────────────────────────────────────────────────
  const LS_CANDLES_KEY = 'tipjar_candles_v1'
  const LS_PRICE_KEY   = 'tipjar_price_v1'
  // localStorage 저장은 캔들 증가 시에만 수행 (매 틱 저장 방지)
  const lastSavedCandleCountRef = useRef(0)

  // 1. 캔들 엔진 (전문 거래소 로직)
  const [currentPrice, setCurrentPrice] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.052450;
    try {
      const saved = localStorage.getItem(LS_PRICE_KEY);
      return saved ? parseFloat(saved) : 0.052450;
    } catch { return 0.052450; }
  })
  const [candles, setCandles] = useState<any[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const saved = localStorage.getItem(LS_CANDLES_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  })
  const tickRef = useRef(0)
  const trendRef = useRef(0)
  const chartScrollRef = useRef<HTMLDivElement>(null)

  const [marginAmount, setMarginAmount] = useState("0.0005")
  const [leverage, setLeverage] = useState<number>(10)
  const [isLongSelection, setIsLongSelection] = useState<boolean>(true)

  // 캔들 늘어날 때마다 우측 끝으로 자동 스크롤
  useEffect(() => {
    if (chartScrollRef.current) {
      chartScrollRef.current.scrollLeft = chartScrollRef.current.scrollWidth;
    }
  }, [candles.length]);

  // ─── candles 변경 시 localStorage 저장 (캔들 개수가 늘어날 때만) ──────────
  useEffect(() => {
    if (candles.length === 0) return;
    if (candles.length > lastSavedCandleCountRef.current) {
      lastSavedCandleCountRef.current = candles.length;
      try {
        localStorage.setItem(LS_CANDLES_KEY, JSON.stringify(candles));
        localStorage.setItem(LS_PRICE_KEY, String(candles[candles.length - 1].close));
      } catch { /* 저장 실패 시 무시 (용량 초과 등) */ }
    }
  }, [candles]);

  useEffect(() => {
    // localStorage에 저장된 캔들이 없으면 초기 캔들 생성
    if (candles.length === 0) {
      const initialPrice = 0.052450;
      setCandles([{
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        open: initialPrice, close: initialPrice, high: initialPrice, low: initialPrice,
        candleRange: [initialPrice, initialPrice]
      }]);
    }

    const interval = setInterval(() => {
      setCurrentPrice(prev => {
        const BASE_PRICE = 0.052450;
        tickRef.current += 1;
        flashCooldownRef.current = Math.max(0, flashCooldownRef.current - 1);

        // ─── Flash 이벤트 (쿨타임 45초, 확률 3%) ───────────────────────────
        let flashMultiplier = 1;
        if (flashCooldownRef.current === 0 && Math.random() < 0.03) {
          const isPump = Math.random() > 0.5;
          const magnitude = 0.05 + Math.random() * 0.07;
          flashMultiplier = isPump ? (1 + magnitude) : (1 - magnitude);
          flashCooldownRef.current = 45;
          const eventInfo: FlashEvent = { type: isPump ? 'PUMP' : 'CRASH', magnitude: Math.round(magnitude * 100) };
          setFlashEvent(eventInfo);
          setTimeout(() => setFlashEvent(null), 3500);
        }

        // ─── 가격 변동 (MAXIMUM VOLATILITY) ─────────────────────────────────
        // 모멘텀 폭 최대화: ±0.0040 (기존 대비 2배)
        trendRef.current = (trendRef.current * 0.50) + ((Math.random() - 0.5) * 0.0040);

        // 방향 반전: 매 틱 35% 확률 (기존 20%)
        if (Math.random() < 0.35) {
          trendRef.current = -trendRef.current * (0.9 + Math.random() * 0.8);
        }

        const gravity = (BASE_PRICE - prev) * 0.003;
        // 노이즈 최대화: ±0.0028
        const noise = (Math.random() - 0.5) * 0.0028;
        const change = trendRef.current + gravity + noise;
        const newPrice = Math.max(0.01, (prev + change) * flashMultiplier);



        const isNewCandle = tickRef.current % 5 === 0;
        const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        setCandles(prevCandles => {
          if (prevCandles.length === 0) return prevCandles;
          const list = [...prevCandles];
          const last = { ...list[list.length - 1] };
          last.close = newPrice;
          last.high = Math.max(last.high, newPrice);
          last.low = Math.min(last.low, newPrice);
          last.candleRange = [last.low, last.high];
          list[list.length - 1] = last;
          if (isNewCandle) {
            list.push({
              time: now,
              open: last.close, close: last.close,
              high: last.close, low: last.close,
              candleRange: [last.close, last.close]
            });
          }
          return list;
        });
        return newPrice;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // 고정밀 캔들 렌더러
  const Candle = (props: any) => {
    const { x, y, width, height, open, close, high, low, candleRange } = props;
    if (!candleRange) return null;
    const isUp = close >= open;
    const color = isUp ? '#0ecb81' : '#f6465d';
    const priceRange = high - low;
    const pixelPerPrice = priceRange > 0 ? height / priceRange : 0;
    const openY = y + (high - open) * pixelPerPrice;
    const closeY = y + (high - close) * pixelPerPrice;
    const bodyTop = Math.min(openY, closeY);
    const bodyBottom = Math.max(openY, closeY);
    const bodyHeight = Math.max(bodyBottom - bodyTop, 1);
    return (
      <g>
        <line x1={x + width / 2} y1={y} x2={x + width / 2} y2={y + height} stroke={color} strokeWidth={1} />
        <rect x={x + 2} y={bodyTop} width={Math.max(width - 4, 1)} height={bodyHeight} fill={color} />
      </g>
    );
  };

  // 2. 컨트랙트 데이터 읽기
  // ─── Optimistic UI 상태 ────────────────────────────────────────────────────
  // 트랜잭션 제출 즉시 화면에 반영, 온체인 확정 후 동기화
  const [optimisticPosition, setOptimisticPosition] = useState<{
    margin: number;
    entryPrice: number;
    leverage: number;
    isLong: boolean;
    timestamp: number;
    isPending?: boolean;
  } | null>(null)

  // ─── 풀 잔액: 3초마다 자동 폴링 → 다른 사용자가 포지션을 잡으면 실시간 반영 ───
  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'getContractBalance',
    query: { refetchInterval: 3000 }  // 3초마다 자동 갱신
  })
  const { data: owner } = useReadContract({
    address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'owner'
  })
  const { data: hasPaidEntry } = useReadContract({
    address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'hasPaidEntryFee',
    args: [address as `0x${string}`],
    query: { enabled: !!address }
  })
  const { data: positionData, refetch: refetchPosition } = useReadContract({
    address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'userPositions',
    args: [address as `0x${string}`],
    query: { enabled: !!address, refetchInterval: 3000 }  // 3초마다 자동 갱신
  })
  // ─── 거래 기록: 5초마다 자동 폴링 → 다른 사용자 거래도 실시간 반영 ────────────
  const { data: tradeHistory, refetch: refetchHistory } = useReadContract({
    address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'getHistory', args: [BigInt(10)],
    query: { refetchInterval: 3000 }  // 3초마다 자동 갱신
  })


  // 포지션 데이터 파싱
  const onChainPosition = useMemo(() => {
    if (!positionData) return null;
    const [margin, entryPrice, leverageValue, isLongBool, timestamp, isOpen] = positionData as any;
    if (!isOpen) return null;
    return {
      margin: Number(formatEther(margin)),
      entryPrice: Number(entryPrice) / 1e8,
      leverage: Number(leverageValue || 1),
      isLong: Boolean(isLongBool !== undefined ? isLongBool : true),
      timestamp: Number(timestamp)
    };
  }, [positionData])

  // ─── 실제 화면 표시에 사용할 포지션: 온체인 데이터가 있으면 우선, 없으면 optimistic 사용
  const activePosition = useMemo(() => {
    if (onChainPosition) {
      // 온체인 확정된 데이터가 돌아오면 optimistic 심프로시스 클리어
      if (optimisticPosition) setOptimisticPosition(null);
      return onChainPosition;
    }
    // 온체인 데이터 없으면 optimistic 데이터 사용 (대기 중 표시)
    return optimisticPosition ? { ...optimisticPosition } : null;
  }, [onChainPosition, optimisticPosition])

  // ── 청산가 계산 ─────────────────────────────────────────────────────────────
  const liquidationPrice = useMemo(() => {
    if (!activePosition) return null;
    return calcLiquidationPrice(activePosition.entryPrice, activePosition.leverage, activePosition.isLong);
  }, [activePosition])

  // ── 청산가 미리보기 (포지션 오픈 전) ──────────────────────────────────────────
  const previewLiquidationPrice = useMemo(() => {
    return calcLiquidationPrice(currentPrice, leverage, isLongSelection);
  }, [currentPrice, leverage, isLongSelection])

  // ── 실시간 PnL 계산 (바이낸스 방식) ─────────────────────────────────────────
  // rawPnL: 수수료 제외 순수 손익 (Gross PnL)
  // fee: 수익이 났을 때만 부과되는 수수료
  // netPnL: 수수료 차감 후 실수령 손익 (Net PnL)
  const pnlData = useMemo(() => {
    if (!activePosition) return { rawPnL: 0, fee: 0, netPnL: 0, isProfit: false };

    const priceDiff = currentPrice - activePosition.entryPrice;
    const directedDiff = activePosition.isLong ? priceDiff : -priceDiff;
    const rawPnL = (activePosition.margin * activePosition.leverage * directedDiff) / activePosition.entryPrice;

    if (rawPnL >= 0) {
      // 수익 시: 수수료 = 순수익 * feeRate%
      const feeRate = 30 + Math.floor(((activePosition.leverage - 1) * 20) / 99);
      const fee = rawPnL * (feeRate / 100);
      const netPnL = rawPnL - fee;
      return { rawPnL, fee, netPnL, isProfit: true, feeRate };
    } else {
      // 손실 시: 청산 시 원금 초과 손실 방지
      const lossAbs = Math.min(Math.abs(rawPnL), activePosition.margin);
      return { rawPnL: -lossAbs, fee: 0, netPnL: -lossAbs, isProfit: false, feeRate: 0 };
    }
  }, [activePosition, currentPrice])

  const pnlPercent = useMemo(() => {
    if (!activePosition) return 0;
    const diffPercent = (currentPrice - activePosition.entryPrice) / activePosition.entryPrice;
    const actualDiff = activePosition.isLong ? diffPercent : -diffPercent;
    const leveragedPercent = actualDiff * 100 * activePosition.leverage;
    return leveragedPercent <= -100 ? -100 : leveragedPercent;
  }, [activePosition, currentPrice])

  // ── 청산 감지 (자동 프론트엔드 강제 청산) ────────────────────────────────────
  const { data: hash, isPending, writeContract } = useWriteContract()
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({ hash })

  useEffect(() => {
    if (!activePosition || !liquidationPrice || liquidatedRef.current) return;

    const isLiquidated = activePosition.isLong
      ? currentPrice <= liquidationPrice
      : currentPrice >= liquidationPrice;

    if (isLiquidated) {
      liquidatedRef.current = true;
      setLiquidationAlert(true);
      // 자동으로 청산 트랜잭션 제출
      writeContract({
        address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'closePosition',
        args: [BigInt(Math.floor(currentPrice * 1e8))]
      });
      setTimeout(() => setLiquidationAlert(false), 5000);
    }
  }, [currentPrice, activePosition, liquidationPrice]);

  // 포지션이 닫히면 청산 플래그 초기화
  useEffect(() => {
    if (!activePosition) {
      liquidatedRef.current = false;
    }
  }, [activePosition]);

  const handleOpenPosition = () => {
    if (!hasPaidEntry && address !== owner) {
      alert("입장료를 먼저 지불해야 합니다!");
      return;
    }
    if (Number(marginAmount) < 0.00001 || Number(marginAmount) > 0.001) {
      alert("투자 가능 수량은 0.00001 ~ 0.001 ETH 사이입니다.");
      return;
    }

    // ─── Optimistic UI: 제출 즉시 포지션을 화면에 표시 ───
    setOptimisticPosition({
      margin: Number(marginAmount),
      entryPrice: currentPrice,
      leverage,
      isLong: isLongSelection,
      timestamp: Math.floor(Date.now() / 1000),
      isPending: true,
    });

    writeContract({
      address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'openPosition',
      args: [BigInt(Math.floor(currentPrice * 1e8)), BigInt(leverage), isLongSelection],
      value: parseEther(marginAmount)
    })
  }

  const handlePayEntryFee = () => {
    writeContract({
      address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'payEntryFee',
      value: parseEther("0.01")
    })
  }

  const handleClosePosition = () => {
    // Optimistic UI: 종료 제출 즉시 화면에서 포지션 클리어
    setOptimisticPosition(null);
    writeContract({
      address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'closePosition',
      args: [BigInt(Math.floor(currentPrice * 1e8))]
    })
  }

  const handleDepositLiquidity = (amount: string) => {
    writeContract({
      address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'depositInitialLiquidity',
      value: parseEther(amount)
    })
  }

  const handleWithdraw = () => {
    writeContract({ address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'withdrawTips' })
  }

  useEffect(() => {
    if (isConfirmed) {
      refetchBalance();
      refetchPosition();
      refetchHistory();
    }
  }, [isConfirmed]);

  // 차트 Y축 도메인: 청산가를 포함하도록 확장
  const chartDomain = useMemo(() => {
    if (candles.length === 0) return ['auto', 'auto'] as const;
    const allPrices = candles.flatMap((c: any) => [c.high, c.low]);
    let minP = Math.min(...allPrices);
    let maxP = Math.max(...allPrices);
    if (liquidationPrice) {
      minP = Math.min(minP, liquidationPrice * 0.999);
      maxP = Math.max(maxP, liquidationPrice * 1.001);
    }
    const padding = (maxP - minP) * 0.1;
    return [minP - padding, maxP + padding] as [number, number];
  }, [candles, liquidationPrice]);

  return (
    <div className="min-h-screen bg-[#0b0e11] text-[#eaecef] font-sans selection:bg-[#fcd535]/30 relative">

      {/* ── 청산 플래시 알림 ─────────────────────────────────────────────────── */}
      {liquidationAlert && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[200] animate-bounce">
          <div className="bg-[#f6465d] text-white px-6 py-4 rounded-xl shadow-2xl shadow-[#f6465d]/40 flex items-center gap-3 border border-[#ff7a8a]">
            <AlertTriangle className="w-6 h-6 animate-pulse" />
            <div>
              <p className="font-black text-lg">⚡ 강제 청산 발생!</p>
              <p className="text-sm opacity-90">청산가 도달 — 포지션이 자동으로 종료되었습니다.</p>
            </div>
          </div>
        </div>
      )}

      {/* ── Flash 이벤트 알림 (상단 중앙 화면 전체 폭) ────────────────────────── */}
      {flashEvent && (
        <div
          className="fixed top-0 left-0 w-full z-[190] pointer-events-none"
          style={{ animation: 'flashBanner 3.5s ease-out forwards' }}
        >
          <div
            className={`w-full py-3 flex items-center justify-center gap-4
              ${flashEvent.type === 'PUMP'
                ? 'bg-gradient-to-r from-[#0ecb81] via-[#12e391] to-[#0ecb81] shadow-lg shadow-[#0ecb81]/50'
                : 'bg-gradient-to-r from-[#f6465d] via-[#ff3a50] to-[#f6465d] shadow-lg shadow-[#f6465d]/50'
              }`}
          >
            <span className="text-2xl">{flashEvent.type === 'PUMP' ? '🚀' : '💥'}</span>
            <div className="text-center">
              <p className="text-black font-black text-xl tracking-tight">
                {flashEvent.type === 'PUMP' ? '⚡ FLASH PUMP' : '📉 FLASH CRASH'}
                <span className="ml-2 text-black/70 text-base">+{flashEvent.magnitude}% 급변동 발생!</span>
              </p>
              <p className="text-black/80 text-xs font-bold">
                {flashEvent.type === 'PUMP'
                  ? '시장이 폭등했습니다! 숏 포지션 청산 위험!'
                  : '시장이 폭락했습니다! 롱 포지션 청산 위험!'}
              </p>
            </div>
            <span className="text-2xl">{flashEvent.type === 'PUMP' ? '🚀' : '💥'}</span>
          </div>
          {/* 화면 테두리 번쩍임 효과 */}
          <div
            className={`fixed inset-0 pointer-events-none border-4
              ${flashEvent.type === 'PUMP' ? 'border-[#0ecb81]' : 'border-[#f6465d]'}
            `}
            style={{ animation: 'flashBorder 0.5s ease-out 3 alternate' }}
          />
        </div>
      )}

      <style>{`
        @keyframes flashBanner {
          0%   { opacity: 1; transform: translateY(0); }
          80%  { opacity: 1; transform: translateY(0); }
          100% { opacity: 0; transform: translateY(-20px); }
        }
        @keyframes flashBorder {
          from { opacity: 1; }
          to   { opacity: 0; }
        }
      `}</style>


      {/* VIP 입장 게이트 */}
      {mounted && isConnected && !hasPaidEntry && address !== owner && (
        <div className="fixed inset-0 z-[100] bg-[#0b0e11]/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#1e2329] p-8 rounded-2xl border border-[#fcd535]/30 shadow-2xl shadow-[#fcd535]/5 max-w-md w-full text-center space-y-6">
            <div className="w-20 h-20 bg-[#fcd535]/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <Key className="w-10 h-10 text-[#fcd535]" />
            </div>
            <h2 className="text-2xl font-black text-white">VIP 전용 거래소 입장</h2>
            <p className="text-[#848e9c] text-sm leading-relaxed">
              본 거래소는 엄선된 파트너만 이용 가능합니다.<br />
              <span className="text-white font-bold">1회성 입장료 0.01 ETH</span>를 지불하고<br />
              실시간 마진 거래를 시작하세요!
            </p>
            <button
              onClick={handlePayEntryFee}
              className="w-full bg-[#fcd535] hover:bg-[#f2c94c] text-black font-black py-4 rounded-xl transition-all transform hover:scale-[1.02] flex items-center justify-center gap-2"
            >
              멤버십 활성화 (0.01 ETH)
              <ArrowRight className="w-5 h-5" />
            </button>
            <p className="text-[10px] text-[#5e6673]">지불된 입장료는 유동성 풀의 보상으로 사용됩니다.</p>
          </div>
        </div>
      )}

      {/* GNB */}
      <nav className="h-[60px] border-b border-[#2b3139] bg-[#181a20] px-6 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2 group cursor-pointer">
            <div className="w-8 h-8 bg-[#fcd535] rounded-lg flex items-center justify-center group-hover:rotate-12 transition-transform">
              <BarChart3 className="text-black w-5 h-5" />
            </div>
            <span className="text-xl font-bold text-white tracking-tighter">ETH TRADER <span className="text-[#fcd535] text-xs font-mono">PRO</span></span>
          </div>
          <div className="hidden md:flex gap-6 text-sm font-medium text-[#848e9c]">
            <span className="text-[#fcd535] cursor-pointer">거래소</span>
            <span className="hover:text-white cursor-pointer transition-colors">마진</span>
            <span className="hover:text-white cursor-pointer transition-colors">리더보드</span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex flex-col items-end">
            <span className="text-[10px] text-[#848e9c] font-bold">EXCHANGE POOL</span>
            <span className="text-sm font-mono text-[#fcd535]">
              {mounted && balance !== undefined ? Number(formatEther(balance as bigint)).toFixed(6) : "0.000000"} ETH
            </span>
          </div>
          {mounted && isConnected ? (
            <button onClick={() => disconnect()} className="flex items-center gap-2 bg-[#2b3139] hover:bg-[#363c44] px-4 py-2 rounded-lg text-sm transition-all border border-[#474d57]">
              <Wallet className="w-4 h-4 text-[#fcd535]" />
              <span className="font-mono text-xs">{address?.slice(0, 6)}...{address?.slice(-4)}</span>
              <LogOut className="w-3 h-3 ml-1 opacity-50" />
            </button>
          ) : (
            <button onClick={() => connect({ connector: connectors[0] })} className="bg-[#fcd535] hover:bg-[#f2c94c] text-black px-6 py-2 rounded-lg text-sm font-bold transition-all shadow-lg shadow-[#fcd535]/10">
              지갑 연결
            </button>
          )}
        </div>
      </nav>

      <main className="max-w-[1400px] mx-auto p-4 grid grid-cols-12 gap-4">
        {/* Left: Chart Section */}
        <div className="col-span-12 lg:col-span-8 flex flex-col gap-4">
          <div className="bg-[#181a20] rounded-xl p-6 border border-[#2b3139] shadow-sm">
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-4">
                <div className="flex flex-col">
                  <span className="text-xs text-[#848e9c] font-bold uppercase tracking-widest">SepoliaETH Index (Real-time)</span>
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-black text-white font-mono">{currentPrice.toFixed(6)} ETH</span>
                    <span className={`text-sm font-bold ${currentPrice >= 0.052450 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {currentPrice >= 0.052450 ? '▲' : '▼'} {Math.abs(((currentPrice - 0.052450) / 0.052450) * 100).toFixed(2)}%
                    </span>
                  </div>
                  {/* 청산가 뱃지 - 포지션 보유 중일 때 헤더에도 표시 */}
                  {activePosition && liquidationPrice && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] font-bold text-[#f6465d] bg-[#f6465d]/10 px-2 py-0.5 rounded border border-[#f6465d]/30 flex items-center gap-1">
                        <Zap className="w-3 h-3" />
                        청산가: {liquidationPrice.toFixed(6)} ETH
                      </span>
                      <span className="text-[10px] text-[#848e9c]">
                        ({((Math.abs(currentPrice - liquidationPrice) / currentPrice) * 100).toFixed(2)}% 거리)
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                {['1S'].map(t => (
                  <button key={t} className={`px-2 py-1 rounded text-[10px] font-bold ${t === '1S' ? 'bg-[#2b3139] text-[#fcd535]' : 'text-[#848e9c]'}`}>{t}</button>
                ))}
              </div>
            </div>

            {/* 가로 스크롤 차트 */}
            <div
              ref={chartScrollRef}
              style={{ height: '400px', width: '100%', overflowX: 'auto', overflowY: 'hidden' }}
              className="css-scrollbar"
            >
              <div style={{ height: '100%', minWidth: '100%', width: `${Math.max(100, (candles.length / 40) * 100)}%` }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={candles} margin={{ top: 20, right: 30, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2b3139" vertical={false} opacity={0.3} />
                    <XAxis dataKey="time" stroke="#5e6673" fontSize={10} tickLine={false} axisLine={false} minTickGap={30} />
                    <YAxis
                      domain={chartDomain}
                      stroke="#5e6673" fontSize={10} tickLine={false} axisLine={false}
                      orientation="right"
                      tickFormatter={(val) => val.toFixed(5)}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1e2329', border: '1px solid #2b3139', borderRadius: '8px', fontSize: '12px' }}
                      cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                      labelStyle={{ color: '#848e9c', marginBottom: '4px' }}
                    />

                    {/* ── 청산가 수평선 ── */}
                    {activePosition && liquidationPrice && (
                      <ReferenceLine
                        y={liquidationPrice}
                        stroke="#f6465d"
                        strokeDasharray="6 3"
                        strokeWidth={1.5}
                        label={{
                          value: `⚡ 청산가 ${liquidationPrice.toFixed(5)}`,
                          position: 'insideTopLeft',
                          fill: '#f6465d',
                          fontSize: 10,
                          fontWeight: 700,
                        }}
                      />
                    )}

                    {/* ── 진입가 수평선 (굵은 실선 + 진입 타점 표시) ── */}
                    {activePosition && (
                      <ReferenceLine
                        y={activePosition.entryPrice}
                        stroke={activePosition.isLong ? '#0ecb81' : '#f6465d'}
                        strokeDasharray="0"
                        strokeWidth={2}
                        label={{
                          value: `● 진입가 ${activePosition.entryPrice.toFixed(6)} (${activePosition.isLong ? 'LONG' : 'SHORT'})`,
                          position: 'insideBottomLeft',
                          fill: activePosition.isLong ? '#0ecb81' : '#f6465d',
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      />
                    )}

                    <Bar dataKey="candleRange" shape={<Candle />} animationDuration={0} isAnimationActive={false}>
                      {candles.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.close >= entry.open ? '#0ecb81' : '#f6465d'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Trade History Table */}
          <div className="bg-[#181a20] rounded-xl border border-[#2b3139] overflow-hidden">
            <div className="px-6 py-4 border-b border-[#2b3139] flex items-center justify-between">
              <h3 className="font-bold flex items-center gap-2">
                <Clock className="w-4 h-4 text-[#fcd535]" /> 최근 투자 기록
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-[#848e9c] text-[11px] uppercase border-b border-[#2b3139]">
                    <th className="px-4 py-3 font-bold">주소</th>
                    <th className="px-4 py-3 font-bold">투자금 / 방향</th>
                    <th className="px-4 py-3 font-bold">진입가</th>
                    {/* ── 분리된 컬럼 ── */}
                    <th className="px-4 py-3 font-bold text-center">총손익 (Gross)</th>
                    <th className="px-4 py-3 font-bold text-center text-[#fcd535]">수수료</th>
                    <th className="px-4 py-3 font-bold text-right">실수령 (Net)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2b3139]">
                  {tradeHistory && (tradeHistory as any[]).map((h, i) => {
                    const marginNum = Number(formatEther(h.margin));
                    const pnlNum = Number(formatEther(h.pnl));     // 컨트랙트 저장값 = Net PnL
                    const leverageUsed = Number(h.leverage || 100);
                    const isLongRecord = h.isLong !== undefined ? h.isLong : true;
                    const feeRateNum = 30 + Math.floor((leverageUsed - 1) * 20 / 99);

                    // Gross PnL 역산: netPnL = grossPnL * (1 - feeRate/100)
                    // => grossPnL = netPnL / (1 - feeRate/100)
                    const grossPnL = h.isProfit ? pnlNum / (1 - feeRateNum / 100) : -pnlNum;
                    const feeEth = h.isProfit ? grossPnL * (feeRateNum / 100) : 0;
                    const netPnL = h.isProfit ? pnlNum : -pnlNum;
                    const roi = (Math.abs(netPnL) / marginNum) * 100 * (h.isProfit ? 1 : -1);
                    const grossRoi = (Math.abs(grossPnL) / marginNum) * 100 * (h.isProfit ? 1 : -1);

                    return (
                      <tr key={i} className="hover:bg-[#2b3139]/30 transition-colors">
                        <td className="px-4 py-4 font-mono text-[#848e9c] text-xs">{h.user.slice(0, 6)}...{h.user.slice(-4)}</td>

                        <td className="px-4 py-4">
                          <span className="block font-bold text-white text-xs">{marginNum.toFixed(5)} ETH</span>
                          <div className="flex items-center gap-1 mt-0.5">
                            <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${isLongRecord ? 'bg-[#0ecb81]/20 text-[#0ecb81]' : 'bg-[#f6465d]/20 text-[#f6465d]'}`}>
                              {isLongRecord ? 'LONG' : 'SHORT'}
                            </span>
                            <span className="text-[10px] text-[#848e9c]">{leverageUsed}X</span>
                          </div>
                        </td>

                        <td className="px-4 py-4 font-mono text-xs text-white">
                          {(Number(h.entryPrice) / 1e8).toFixed(6)}
                        </td>

                        {/* Gross PnL */}
                        <td className={`px-4 py-4 text-center ${h.isProfit ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                          <span className="block font-bold text-xs">
                            {grossPnL >= 0 ? '+' : ''}{grossPnL.toFixed(6)} ETH
                          </span>
                          <span className={`text-[10px] px-1 py-0.5 rounded font-black ${h.isProfit ? 'bg-[#0ecb81]/10' : 'bg-[#f6465d]/10'}`}>
                            {grossRoi > 0 ? '+' : ''}{grossRoi.toFixed(2)}%
                          </span>
                        </td>

                        {/* 수수료 */}
                        <td className="px-4 py-4 text-center">
                          {h.isProfit ? (
                            <div>
                              <span className="block text-[#fcd535] font-mono font-bold text-xs">-{feeEth.toFixed(6)} ETH</span>
                              <span className="text-[10px] text-[#848e9c]">{feeRateNum}% 징수</span>
                            </div>
                          ) : (
                            <span className="text-[10px] text-[#474d57]">해당없음</span>
                          )}
                        </td>

                        {/* Net PnL */}
                        <td className={`px-4 py-4 text-right ${h.isProfit ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                          <span className="block font-bold text-sm">
                            {netPnL >= 0 ? '+' : ''}{netPnL.toFixed(6)} ETH
                          </span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-black ${h.isProfit ? 'bg-[#0ecb81]/20' : 'bg-[#f6465d]/20'}`}>
                            {roi > 0 ? '+' : ''}{roi.toFixed(2)}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {(!tradeHistory || (tradeHistory as any[]).length === 0) && (
                    <tr><td colSpan={6} className="px-6 py-12 text-center text-[#474d57]">거래 내역이 없습니다. 첫 번째 포지션을 오픈해 보세요!</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right: Trading Section */}
        <div className="col-span-12 lg:col-span-4 flex flex-col gap-4">
          {/* Active Position Dashboard */}
          <div className={`bg-[#181a20] rounded-xl p-6 border border-[#2b3139] bg-gradient-to-br from-[#181a20] to-[#1e2329] border-l-4 ${activePosition ? (activePosition.isLong ? 'border-l-[#0ecb81]' : 'border-l-[#f6465d]') : 'border-l-[#fcd535]'}`}>
            <span className={`text-[10px] font-black uppercase tracking-tighter ${activePosition ? (activePosition.isLong ? 'text-[#0ecb81]' : 'text-[#f6465d]') : 'text-[#fcd535]'}`}>
              MY ACTIVE POSITION {activePosition && (activePosition.isLong ? '(LONG)' : '(SHORT)')}
            </span>

            {activePosition ? (
              <div className="mt-4 space-y-3">
                {/* 수익률 + Net PnL */}
                <div className="flex justify-between items-baseline">
                  <div className="flex flex-col">
                    <span className={`text-3xl font-black font-mono ${pnlPercent >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(2)}%
                    </span>
                    <span className="text-xs text-[#848e9c]">실시간 수익률</span>
                  </div>
                  <div className="text-right">
                    <span className={`text-lg font-bold font-mono ${pnlData.netPnL >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {pnlData.netPnL >= 0 ? '+' : ''}{pnlData.netPnL.toFixed(6)} ETH
                    </span>
                    <p className="text-[10px] text-[#848e9c]">Net PnL (수수료 후)</p>
                  </div>
                </div>

                {/* PnL 상세 분해 */}
                <div className="bg-[#0b0e11] rounded-lg p-3 space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-[#848e9c]">총 손익 (Gross PnL)</span>
                    <span className={`font-bold font-mono ${pnlData.rawPnL >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {pnlData.rawPnL >= 0 ? '+' : ''}{pnlData.rawPnL.toFixed(6)} ETH
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-[#848e9c]">수수료 ({pnlData.feeRate ?? 0}%)</span>
                    <span className="text-[#fcd535] font-mono">
                      {pnlData.fee > 0 ? `-${pnlData.fee.toFixed(6)}` : '0.000000'} ETH
                    </span>
                  </div>
                  <div className="border-t border-[#2b3139] pt-1.5 flex justify-between text-xs">
                    <span className="text-white font-bold">실수령 (Net PnL)</span>
                    <span className={`font-black font-mono ${pnlData.netPnL >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {pnlData.netPnL >= 0 ? '+' : ''}{pnlData.netPnL.toFixed(6)} ETH
                    </span>
                  </div>
                </div>

                {/* ─ 청산가 위험 게이지 ─ */}
                {liquidationPrice && (
                  <div className="bg-[#1a0a0c] border border-[#f6465d]/30 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] text-[#f6465d] font-black flex items-center gap-1">
                        <Zap className="w-3 h-3" /> 강제 청산가
                      </span>
                      <span className="text-xs font-bold font-mono text-[#f6465d]">{liquidationPrice.toFixed(6)} ETH</span>
                    </div>
                    {/* 현재가와 청산가 사이 거리 게이지 */}
                    {(() => {
                      const dist = Math.abs(currentPrice - liquidationPrice);
                      const distPct = (dist / currentPrice) * 100;
                      const danger = Math.max(0, Math.min(100, 100 - distPct * 10));
                      const barColor = danger > 70 ? '#f6465d' : danger > 40 ? '#fcd535' : '#0ecb81';
                      return (
                        <div>
                          <div className="w-full bg-[#2b3139] rounded-full h-1.5 mb-1">
                            <div
                              className="h-1.5 rounded-full transition-all duration-500"
                              style={{ width: `${danger}%`, backgroundColor: barColor }}
                            />
                          </div>
                          <div className="flex justify-between text-[9px] text-[#848e9c]">
                            <span>청산까지 {distPct.toFixed(2)}% 남음</span>
                            <span style={{ color: barColor }} className="font-bold">
                              {danger > 70 ? '⚠️ 매우 위험' : danger > 40 ? '주의 요망' : '안전'}
                            </span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* 포지션 정보 그리드 */}
                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[#2b3139]">
                  <div>
                    <p className="text-[10px] text-[#848e9c]">투자 원금</p>
                    <p className="text-sm font-bold text-white font-mono">
                      {activePosition.margin.toFixed(5)} <span className="text-[#fcd535] text-[10px]">({activePosition.leverage}X)</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] text-[#848e9c]">진입가</p>
                    <p className="text-sm font-bold text-white font-mono">{activePosition.entryPrice.toFixed(6)}</p>
                  </div>
                </div>

                <button
                  onClick={handleClosePosition} disabled={isPending || isConfirming}
                  className="w-full bg-[#f6465d] hover:bg-[#ff5b6f] text-white py-3 rounded-lg font-bold shadow-lg shadow-[#f6465d]/20 transition-all flex items-center justify-center gap-2"
                >
                  {isPending || isConfirming ? <Clock className="animate-spin w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
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

          {/* Trade Tool Panel */}
          {!activePosition && (
            <div className="bg-[#181a20] rounded-xl border border-[#2b3139] overflow-hidden shadow-sm">
              <div className="grid grid-cols-2">
                <button
                  onClick={() => setIsLongSelection(true)}
                  className={`py-3 text-sm font-bold transition-colors ${isLongSelection ? 'bg-[#2b3139] text-[#0ecb81] border-b-2 border-b-[#0ecb81]' : 'text-[#848e9c]'}`}
                >롱 (상승베팅)</button>
                <button
                  onClick={() => setIsLongSelection(false)}
                  className={`py-3 text-sm font-bold transition-colors ${!isLongSelection ? 'bg-[#2b3139] text-[#f6465d] border-b-2 border-b-[#f6465d]' : 'text-[#848e9c]'}`}
                >숏 (하락베팅)</button>
              </div>
              <div className="p-6 space-y-5">
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-[#848e9c] font-bold">투자 수량(Margin)</span>
                    <span className="text-[10px] text-[#474d57]">최소 0.00001 / 최대 0.001</span>
                  </div>
                  <div className="bg-[#2b3139] p-3 rounded-lg flex justify-between items-center border border-transparent focus-within:border-[#fcd535] transition-all">
                    <div className="flex items-center gap-2">
                      <Wallet2 className="w-4 h-4 text-[#848e9c]" />
                      <input
                        type="number" step="0.00001" value={marginAmount} onChange={e => setMarginAmount(e.target.value)}
                        className="bg-transparent text-sm font-bold text-white outline-none w-full"
                        placeholder="0.00"
                      />
                    </div>
                    <span className="text-xs font-bold text-[#fcd535]">ETH</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-[#848e9c] font-bold">레버리지 조절</span>
                    <span className="text-[10px] text-[#fcd535]">{leverage}X</span>
                  </div>
                  <div className="flex gap-2">
                    {[1, 10, 50, 100].map(val => (
                      <button
                        key={val} onClick={() => setLeverage(val)}
                        className={`flex-1 py-1 text-xs font-bold rounded transition-all ${leverage === val ? 'bg-[#fcd535] text-black shadow-lg shadow-[#fcd535]/30' : 'bg-[#2b3139] text-[#848e9c] hover:bg-[#2b3139]/80'}`}
                      >{val}X</button>
                    ))}
                  </div>
                  <p className="text-[9px] text-right text-[#848e9c]">수익 수수료율: <span className="text-[#f6465d]">{30 + Math.floor(((leverage - 1) * 20) / 99)}%</span> 적용</p>
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
                </div>

                <button
                  onClick={handleOpenPosition}
                  disabled={!mounted || isPending || isConfirming || !isConnected}
                  className={`w-full text-white font-black py-4 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${isLongSelection ? 'bg-[#0ecb81] hover:bg-[#12e391] shadow-lg shadow-[#0ecb81]/10' : 'bg-[#f6465d] hover:bg-[#ff5b6f] shadow-lg shadow-[#f6465d]/10'}`}
                >
                  {isPending || isConfirming ? <Clock className="animate-spin w-5 h-5" /> : (isLongSelection ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />)}
                  {isLongSelection ? '상승 포지션 진입 (LONG)' : '하락 포지션 진입 (SHORT)'}
                </button>

                {!mounted || !isConnected ? (
                  <p className="text-[10px] text-[#f6465d] text-center font-bold font-mono animate-pulse underline">지갑을 먼저 연결해 주세요!</p>
                ) : null}
              </div>
            </div>
          )}

          {/* Admin Founder Panel */}
          {mounted && address === owner && (
            <div className="bg-[#181a20] rounded-xl p-6 border border-[#2b3139] border-t-4 border-t-[#fcd535] mt-auto">
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-black text-[#fcd535]">FOUNDER DASHBOARD</span>
                <span className="text-[10px] font-mono text-white bg-[#2b3139] px-2 py-0.5 rounded">ADMIN</span>
              </div>
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="bg-[#2b3139] p-3 rounded-lg text-center">
                  <p className="text-[10px] text-[#848e9c]">현재 풀 잔액</p>
                  <p className="text-sm font-black text-white">{balance !== undefined ? Number(formatEther(balance as bigint)).toFixed(6) : "0.000000"} ETH</p>
                </div>
                <div className="bg-[#2b3139] p-3 rounded-lg text-center">
                  <p className="text-[10px] text-[#848e9c]">유동성 목표</p>
                  <p className="text-sm font-black text-[#0ecb81]">HEALTHY</p>
                </div>
              </div>
              {/* 유동성 단계별 공급 버튼 */}
              <div className="space-y-2">
                <p className="text-[10px] text-[#848e9c] font-bold mb-1">유동성 공급 (ETH)</p>
                <div className="grid grid-cols-3 gap-2">
                  {['0.01', '0.05', '0.1'].map(amt => (
                    <button
                      key={amt}
                      onClick={() => handleDepositLiquidity(amt)}
                      disabled={isPending || isConfirming}
                      className="bg-[#fcd535] text-black hover:bg-[#f2c94c] py-2 rounded-lg text-xs font-black transition flex items-center justify-center gap-1 disabled:opacity-50"
                    >
                      <ArrowRightLeft className="w-3 h-3" />
                      +{amt}
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={handleWithdraw} disabled={isPending || isConfirming}
                className="w-full border border-[#f6465d] text-[#f6465d] hover:bg-[#f6465d]/10 py-3 rounded-lg text-[10px] font-bold transition"
              >
                거래소 정산 및 전체 수익 회수
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Footer Status Bar */}
      <footer className="h-[25px] bg-[#181a20] border-t border-[#2b3139] px-4 flex items-center justify-between text-[10px] text-[#848e9c] fixed bottom-0 w-full z-50">
        <div className="flex gap-4">
          <span className="flex items-center gap-1"><div className="w-1.5 h-1.5 bg-[#0ecb81] rounded-full animate-pulse"></div> 서버 상태: 정상</span>
          <span>지연시간: 12ms</span>
          <span className="text-[#fcd535]">Sepolia Testnet</span>
        </div>
        <div>© 2026 ETH Trader Pro v2.0 - Blockchain Middle Test</div>
      </footer>
    </div>
  )
}
