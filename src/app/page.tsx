'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useAccount, useConnect, useDisconnect, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { formatEther, parseEther } from 'viem'
import { TIPJAR_ABI, TIPJAR_ADDRESS } from '@/config/contract'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { Wallet, LogOut, TrendingUp, TrendingDown, Clock, ArrowRightLeft, Wallet2, BarChart3, Key, ArrowRight } from 'lucide-react'

export default function Home() {
  const { address, isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()

  // 하이드레이션 에러 방지용 mounted 상태
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  // 1. 캔들 엔진 (전문 거래소 로직)
  const [currentPrice, setCurrentPrice] = useState(0.052450)
  const [candles, setCandles] = useState<any[]>([])
  const tickRef = useRef(0)
  const trendRef = useRef(0) // 추세(모멘텀) 적용용 상태
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

  useEffect(() => {
    // 초기 캔들 생성
    const initialPrice = 0.052450;
    setCandles([{
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      open: initialPrice, close: initialPrice, high: initialPrice, low: initialPrice, candleRange: [initialPrice, initialPrice]
    }]);

    const interval = setInterval(() => {
      setCurrentPrice(prev => {
        // 시장 변동성 로직 (관성 추세 + 기준점 회귀 + 무작위 잔파동)
        const BASE_PRICE = 0.052450;
        
        // 1. 관성 (Momentum): 한 방향으로 가려는 힘
        trendRef.current = (trendRef.current * 0.85) + ((Math.random() - 0.5) * 0.0002);
        
        // 2. 회귀 본능 (Gravity): 가격이 기준선(0.052450)에서 너무 멀어지면 반대 방향으로 당기는 힘
        // 이 힘 덕분에 무한정 오르거나 무한정 내리지 않고 양봉/음봉이 번갈아 나옵니다.
        const gravity = (BASE_PRICE - prev) * 0.02; 
        
        // 3. 노이즈 (Noise): 1초마다 발생하여 꼬리를 형성하는 무작위 잔파동
        const noise = (Math.random() - 0.5) * 0.0001;
        
        const change = trendRef.current + gravity + noise;
        const newPrice = Math.max(0.01, prev + change);
        
        tickRef.current += 1;
        const isNewCandle = tickRef.current % 5 === 0;
        const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        setCandles(prevCandles => {
          if (prevCandles.length === 0) return prevCandles;
          
          const list = [...prevCandles];
          const last = { ...list[list.length - 1] };
          
          // 실시간 변동 적용
          last.close = newPrice;
          last.high = Math.max(last.high, newPrice);
          last.low = Math.min(last.low, newPrice);
          last.candleRange = [last.low, last.high];
          list[list.length - 1] = last;

          if (isNewCandle) {
            // 다음 봉 시작: 시가는 무조건 전 봉의 종가와 동일 (연속성)
            list.push({
              time: now,
              open: last.close,
              close: last.close,
              high: last.close,
              low: last.close,
              candleRange: [last.close, last.close]
            });
          }
          return list; // 제한 없이 무한으로 스택 쌓음
        });
        
        return newPrice;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // 고정밀 캔들 렌더러 (Bounding Box 기반 안전 렌더링)
  const Candle = (props: any) => {
    const { x, y, width, height, open, close, high, low, candleRange } = props;
    if (!candleRange) return null;
    
    const isUp = close >= open;
    const color = isUp ? '#0ecb81' : '#f6465d';

    // y는 항상 고가(High)의 최상단 화면 좌표이며, height는 전체 꼬리의 총 길이입니다.
    const priceRange = high - low;
    const pixelPerPrice = priceRange > 0 ? height / priceRange : 0;
    
    // 시가와 종가의 Y 화면 좌표 계산
    const openY = y + (high - open) * pixelPerPrice;
    const closeY = y + (high - close) * pixelPerPrice;
    
    const bodyTop = Math.min(openY, closeY);
    const bodyBottom = Math.max(openY, closeY);
    const bodyHeight = Math.max(bodyBottom - bodyTop, 1); // 캔들 몸통 최소 1px 보장

    return (
      <g>
        {/* 심지 (Wick) - Bar의 전체 영역(y ~ y + height) 1px 선 */}
        <line 
          x1={x + width / 2} 
          y1={y} 
          x2={x + width / 2} 
          y2={y + height} 
          stroke={color} 
          strokeWidth={1} 
        />
        {/* 몸통 (Body) - 계산된 실제 종가/시가 좌표 기준 */}
        <rect 
          x={x + 2} 
          y={bodyTop} 
          width={Math.max(width - 4, 1)} 
          height={bodyHeight} 
          fill={color} 
        />
      </g>
    );
  };

  // 2. 컨트랙트 데이터 읽기
  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'getContractBalance'
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
    address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'userPositions', args: [address as `0x${string}`],
    query: { enabled: !!address }
  })
  const { data: tradeHistory, refetch: refetchHistory } = useReadContract({
    address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'getHistory', args: [BigInt(10)]
  })

  // 포지션 데이터 파싱
  const activePosition = useMemo(() => {
    if (!positionData) return null;
    const [margin, entryPrice, leverageValue, isLongBool, timestamp, isOpen] = positionData as any;
    if (!isOpen) return null;
    return {
      margin: Number(formatEther(margin)),
      entryPrice: Number(entryPrice) / 1e8, // 1e8로 나누어 소수점 복원
      leverage: Number(leverageValue || 1), // 배율 파싱
      isLong: Boolean(isLongBool !== undefined ? isLongBool : true),
      timestamp: Number(timestamp)
    };
  }, [positionData]);

  // 실시간 예상 수익 계산 (방향성 적용)
  const currentPnL = useMemo(() => {
    if (!activePosition) return 0;
    const isUp = currentPrice >= activePosition.entryPrice;
    const isProfit = activePosition.isLong ? isUp : !isUp;
    const diff = isUp ? currentPrice - activePosition.entryPrice : activePosition.entryPrice - currentPrice;
    const rawPnL = (activePosition.margin * activePosition.leverage * diff) / activePosition.entryPrice;

    if (isProfit) {
      // 30% 기본 수수료 + 레버리지 비례 할증 (100배 = 50%)
      const feeRate = 30 + Math.floor(((activePosition.leverage - 1) * 20) / 99);
      return rawPnL * ((100 - feeRate) / 100); 
    } else {
      if (rawPnL >= activePosition.margin) return -activePosition.margin; // 100% 손실 시 원금 청산
      return -rawPnL;
    }
  }, [activePosition, currentPrice]);

  const pnlPercent = useMemo(() => {
    if (!activePosition) return 0;
    const diffPercent = (currentPrice - activePosition.entryPrice) / activePosition.entryPrice;
    const actualDiff = activePosition.isLong ? diffPercent : -diffPercent;
    const leveragedPercent = actualDiff * 100 * activePosition.leverage;
    return leveragedPercent <= -100 ? -100 : leveragedPercent;
  }, [activePosition, currentPrice]);

  // 3. 트랜잭션 처리
  const { data: hash, isPending, writeContract } = useWriteContract()
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({ hash })

  const handleOpenPosition = () => {
    if (!hasPaidEntry && address !== owner) {
      alert("입장료를 먼저 지불해야 합니다!");
      return;
    }
    if (Number(marginAmount) < 0.00001 || Number(marginAmount) > 0.001) {
      alert("투자 가능 수량은 0.00001 ~ 0.001 ETH 사이입니다.");
      return;
    }
    writeContract({
      address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'openPosition',
      args: [BigInt(Math.floor(currentPrice * 1e8)), BigInt(leverage), isLongSelection], // 방향(isLong) 전달
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
    writeContract({
      address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'closePosition',
      args: [BigInt(Math.floor(currentPrice * 1e8))]
    })
  }

  const handleDepositLiquidity = () => {
    writeContract({
      address: TIPJAR_ADDRESS, abi: TIPJAR_ABI, functionName: 'depositInitialLiquidity',
      value: parseEther("0.03")
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

  return (
    <div className="min-h-screen bg-[#0b0e11] text-[#eaecef] font-sans selection:bg-[#fcd535]/30 relative">
      {/* VIP 입장 게이트 (입장료 미지불 시) */}
      {mounted && isConnected && !hasPaidEntry && address !== owner && (
        <div className="fixed inset-0 z-[100] bg-[#0b0e11]/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#1e2329] p-8 rounded-2xl border border-[#fcd535]/30 shadow-2xl shadow-[#fcd535]/5 max-w-md w-full text-center space-y-6">
            <div className="w-20 h-20 bg-[#fcd535]/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <Key className="w-10 h-10 text-[#fcd535]" />
            </div>
            <h2 className="text-2xl font-black text-white">VIP 전용 거래소 입장</h2>
            <p className="text-[#848e9c] text-sm leading-relaxed">
              본 거래소는 엄선된 파트너만 이용 가능합니다.<br/> 
              <span className="text-white font-bold">1회성 입장료 0.01 ETH</span>를 지불하고<br/>
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
                </div>
              </div>
              <div className="flex gap-2">
                {['1S'].map(t => (
                  <button key={t} className={`px-2 py-1 rounded text-[10px] font-bold ${t === '1S' ? 'bg-[#2b3139] text-[#fcd535]' : 'text-[#848e9c]'}`}>{t}</button>
                ))}
              </div>
            </div>
            
            {/* 가로 스크롤 컨테이너: 캔들이 늘어나면 width가 동적으로 길어집니다. */}
            <div 
              ref={chartScrollRef} 
              style={{ height: '400px', width: '100%', overflowX: 'auto', overflowY: 'hidden' }}
              className="css-scrollbar"
            >
              <div style={{ height: '100%', minWidth: '100%', width: `${Math.max(100, (candles.length / 40) * 100)}%` }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={candles} margin={{ top: 20, right: 30, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2b3139" vertical={false} opacity={0.3} />
                  <XAxis 
                    dataKey="time" 
                    stroke="#5e6673" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false}
                    minTickGap={30}
                  />
                  <YAxis 
                    domain={['auto', 'auto']} 
                    stroke="#5e6673" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false}
                    orientation="right"
                    tickFormatter={(val) => val.toFixed(5)}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1e2329', border: '1px solid #2b3139', borderRadius: '8px', fontSize: '12px' }}
                    cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                    labelStyle={{ color: '#848e9c', marginBottom: '4px' }}
                  />
                  <Bar 
                    dataKey="candleRange" 
                    shape={<Candle />}
                    animationDuration={0}
                    isAnimationActive={false}
                  >
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
                    <th className="px-6 py-3 font-bold">주소</th>
                    <th className="px-6 py-3 font-bold">투자금(ETH)</th>
                    <th className="px-6 py-3 font-bold">진입/종료가</th>
                    <th className="px-6 py-3 font-bold">수수료(ETH)</th>
                    <th className="px-6 py-3 font-bold text-right">손익(PnL) & 수익률</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2b3139]">
                  {tradeHistory && (tradeHistory as any[]).map((h, i) => {
                    const marginNum = Number(formatEther(h.margin));
                    const pnlNum = Number(formatEther(h.pnl));
                    const leverageUsed = Number(h.leverage || 100);
                    const isLongRecord = h.isLong !== undefined ? h.isLong : true;
                    const feeRate = BigInt(30 + Math.floor((leverageUsed - 1) * 20 / 99));
                    // 수수료 = 순수익 * feeRate / (100 - feeRate)
                    const feeEth = h.isProfit ? formatEther((h.pnl * feeRate) / (100n - feeRate)) : "0";
                    const roi = (pnlNum / marginNum) * 100 * (h.isProfit ? 1 : -1);

                    return (
                      <tr key={i} className="hover:bg-[#2b3139]/30 transition-colors">
                        <td className="px-6 py-4 font-mono text-[#848e9c]">{h.user.slice(0, 6)}...{h.user.slice(-4)}</td>
                        <td className="px-6 py-4 font-bold text-white">{formatEther(h.margin)}</td>
                        <td className="px-6 py-4">
                          <span className="block text-white">진입: {(Number(h.entryPrice) / 1e8).toFixed(6)}</span>
                          <span className="block text-[10px] flex items-center gap-1 font-bold">
                            <span className={isLongRecord ? 'text-[#0ecb81]' : 'text-[#f6465d]'}>{isLongRecord ? 'LONG' : 'SHORT'}</span>
                            <span className="text-[#848e9c]">배율: {leverageUsed}X</span>
                          </span>
                        </td>
                        <td className="px-6 py-4 text-[#fcd535] text-xs font-mono">{Number(feeEth).toFixed(6)}</td>
                        <td className={`px-6 py-4 text-right flex flex-col items-end justify-center gap-1 ${h.isProfit ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                          <span className="font-bold text-sm">{h.isProfit ? '+' : '-'}{Number(formatEther(h.pnl)).toFixed(6)} ETH</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-black ${h.isProfit ? 'bg-[#0ecb81]/20' : 'bg-[#f6465d]/20'}`}>
                            {roi > 0 ? '+' : ''}{roi.toFixed(2)}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {(!tradeHistory || (tradeHistory as any[]).length === 0) && (
                    <tr><td colSpan={5} className="px-6 py-12 text-center text-[#474d57]">거래 내역이 없습니다. 첫 번째 포지션을 오픈해 보세요!</td></tr>
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
              <div className="mt-4 space-y-4">
                <div className="flex justify-between items-baseline">
                  <div className="flex flex-col">
                    <span className="text-3xl font-black text-white font-mono">
                      {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(2)}%
                    </span>
                    <span className="text-xs text-[#848e9c]">실시간 예상 수익율</span>
                  </div>
                  <div className="text-right">
                    <span className={`text-lg font-bold font-mono ${currentPnL >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {currentPnL >= 0 ? '+' : ''}{currentPnL.toFixed(6)} ETH
                    </span>
                    <p className="text-[10px] text-[#848e9c]">PnL (예상 순수익)</p>
                  </div>
                </div>
                <div className="bg-[#2b3139]/50 p-2 rounded text-[9px] text-[#848e9c] flex justify-between">
                  <span>변동 수수료율</span>
                  <span className="text-[#fcd535]">수익금의 {30 + Math.floor(((activePosition.leverage - 1) * 20) / 99)}% 징수</span>
                </div>
                <div className="grid grid-cols-2 gap-4 pt-2 border-t border-[#2b3139]">
                  <div>
                    <p className="text-[10px] text-[#848e9c]">투자 원금</p>
                    <p className="text-sm font-bold text-white font-mono">{activePosition.margin.toFixed(4)} <span className="text-[#fcd535] text-[10px]">({activePosition.leverage}X)</span></p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] text-[#848e9c]">진입 가격</p>
                    <p className="text-sm font-bold text-white font-mono">{activePosition.entryPrice.toFixed(6)} ETH</p>
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
              <div className="p-6 space-y-6">
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-[#848e9c] font-bold">투자 수량(Margin)</span>
                    <span className="text-[10px] text-[#474d57]">최소 0.00001 / 최대 0.001</span>
                  </div>
                  <div className="bg-[#2b3139] p-3 rounded-lg flex justify-between items-center group border border-transparent focus-within:border-[#fcd535] transition-all">
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

                <div className="space-y-2 mt-4">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-[#848e9c] font-bold">레버리지 조절</span>
                    <span className="text-[10px] text-[#fcd535]">{leverage}X</span>
                  </div>
                  <div className="flex gap-2">
                    {[1, 10, 50, 100].map(val => (
                      <button 
                        key={val} 
                        onClick={() => setLeverage(val)}
                        className={`flex-1 py-1 text-xs font-bold rounded transiton-all ${leverage === val ? 'bg-[#fcd535] text-black shadow-lg shadow-[#fcd535]/30' : 'bg-[#2b3139] text-[#848e9c] hover:bg-[#2b3139]/80'}`}
                      >
                        {val}X
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] text-right text-[#848e9c]">수익 수수료율: <span className="text-[#f6465d]">{30 + Math.floor(((leverage - 1) * 20) / 99)}%</span> 적용</p>
                </div>

                <div className="bg-[#2b3139]/50 p-4 rounded-lg space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-[#848e9c]">진입가 (시뮬레이션)</span>
                    <span className="text-white font-mono text-[10px]">{currentPrice.toFixed(8)} ETH</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-[#848e9c]">청산 예상 위험도</span>
                    <span className={`${leverage >= 50 ? 'text-[#f6465d]' : leverage >= 10 ? 'text-[#fcd535]' : 'text-[#0ecb81]'} font-bold`}>
                      {leverage >= 50 ? '매우 높음 (수시 청산)' : leverage >= 10 ? '중간 (시장가 주의)' : '낮음 (현물 위주)'}
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
              <button 
                onClick={handleDepositLiquidity} disabled={isPending || isConfirming}
                className="w-full bg-[#fcd535] text-black hover:bg-[#fcd535]/80 py-3 rounded-lg text-xs font-bold transition flex items-center justify-center gap-2 mb-2"
              >
                <ArrowRightLeft className="w-4 h-4" /> 유동성 0.03 ETH 추가 공급
              </button>
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
        <div>
          © 2026 ETH Trader Pro v2.0 - Blockchain Middle Test
        </div>
      </footer>
    </div>
  )
}
