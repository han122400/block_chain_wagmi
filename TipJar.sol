// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract TipJar {
    address public owner;
    
    struct Position {
        uint256 margin;      // 친구가 판돈으로 건 ETH
        uint256 entryPrice;  // 시작 시점의 시세 (예: 3500)
        uint256 leverage;    // 사용자가 선택한 배율 (1 ~ 100)
        bool isLong;         // Long(상승)이면 true, Short(하락)이면 false
        uint256 timestamp;
        bool isOpen;
    }

    struct TradeRecord {
        address user;
        uint256 margin;
        uint256 entryPrice;
        uint256 exitPrice;
        uint256 leverage;    // 표시에 활용될 배율
        bool isLong;         // 롱/숏 포지션 타입 기록
        uint256 pnl;         // Profit and Loss (수익 또는 손실액)
        bool isProfit;
        uint256 timestamp;
    }

    mapping(address => Position) public userPositions;
    mapping(address => bool) public hasPaidEntryFee; // 입장료 지불 명부 추가
    uint256 public constant ENTRY_FEE = 0.01 ether;
    TradeRecord[] public history;

    error OnlyOwner();
    error PositionAlreadyOpen();
    error NoActivePosition();
    error InsufficientContractLiquidity();
    error TransferFailed();
    error InvalidPrice();
    error IncorrectEntryFee();
    error EntryFeeRequired();

    event PositionOpened(address indexed user, uint256 margin, uint256 price);
    event PositionClosed(address indexed user, uint256 pnl, bool isProfit);
    event EntryFeePaid(address indexed user);

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // [설립자 전용] 유동성 공급 (친구들 수익금 지급용)
    function depositInitialLiquidity() external payable {}

    // 입장료 지불 함수
    function payEntryFee() external payable {
        if (msg.value != ENTRY_FEE) revert IncorrectEntryFee();
        hasPaidEntryFee[msg.sender] = true;
        emit EntryFeePaid(msg.sender);
    }

    // 1. 포지션 오픈 (베팅 시작)
    // _price: 현재 시세 (USD 기준처럼 큰 정수 사용)
    // _leverage: 배율 (1 ~ 100)
    // _isLong: 상승 베팅 여부
    function openPosition(uint256 _price, uint256 _leverage, bool _isLong) external payable {
        if (!hasPaidEntryFee[msg.sender] && msg.sender != owner) revert EntryFeeRequired(); // 주인은 면제
        if (msg.value < 0.00001 ether || msg.value > 0.001 ether) revert InvalidPrice();
        if (_leverage < 1 || _leverage > 100) revert("Invalid leverage");
        if (userPositions[msg.sender].isOpen) revert PositionAlreadyOpen();
        if (_price == 0) revert InvalidPrice();

        userPositions[msg.sender] = Position({
            margin: msg.value,
            entryPrice: _price,
            leverage: _leverage,
            isLong: _isLong,
            timestamp: block.timestamp,
            isOpen: true
        });

        emit PositionOpened(msg.sender, msg.value, _price);
    }

    // 2. 포지션 종료 (수익 확정)
    // _currentPrice: 현재 시세
    function closePosition(uint256 _currentPrice) external {
        Position storage pos = userPositions[msg.sender];
        if (!pos.isOpen) revert NoActivePosition();
        if (_currentPrice == 0) revert InvalidPrice();

        uint256 payout;
        bool isProfit;
        uint256 pnl;

        // 수익/손실 차이 계산 (사용자가 설정한 레버리지 적용)
        uint256 leverage = pos.leverage;
        
        bool isUp = _currentPrice >= pos.entryPrice;
        bool priceMatchesPosition = (pos.isLong && isUp) || (!pos.isLong && !isUp);
        uint256 priceDiff = isUp ? _currentPrice - pos.entryPrice : pos.entryPrice - _currentPrice;
        
        if (priceMatchesPosition) {
            uint256 rawProfit = (pos.margin * leverage * priceDiff) / pos.entryPrice;
            
            isProfit = true;
            // [수수료 차등 부과 로직]
            // 기본 30% 시작, 100배일 때 50%까지 레버리지에 비례하여 징수
            uint256 feeRate = 30 + ((leverage - 1) * 20 / 99);
            uint256 fee = (rawProfit * feeRate) / 100;
            
            pnl = rawProfit - fee;
            payout = pos.margin + pnl;
            
            if (address(this).balance < payout) revert InsufficientContractLiquidity();
        } else {
            uint256 loss = (pos.margin * leverage * priceDiff) / pos.entryPrice;
            
            isProfit = false;
            if (loss >= pos.margin) {
                // 청산 (Liquidation)
                pnl = pos.margin;
                payout = 0;
            } else {
                pnl = loss;
                payout = pos.margin - loss;
            }
        }

        pos.isOpen = false;
        history.push(TradeRecord(msg.sender, pos.margin, pos.entryPrice, _currentPrice, leverage, pos.isLong, pnl, isProfit, block.timestamp));

        // 최종 계산된 금액 송금
        (bool success, ) = payable(msg.sender).call{value: payout}("");
        if (!success) revert TransferFailed();

        emit PositionClosed(msg.sender, pnl, isProfit);
    }

    // 3. 강제 청산 (Liquidation) - 손실이 원금을 초과한 포지션을 시장에서 퇴출
    function liquidatePosition(address _user, uint256 _currentPrice) external {
        Position storage pos = userPositions[_user];
        if (!pos.isOpen) revert NoActivePosition();

        bool isUp = _currentPrice >= pos.entryPrice;
        bool priceMatchesPosition = (pos.isLong && isUp) || (!pos.isLong && !isUp);
        if (priceMatchesPosition) revert("Cannot liquidate profit position");

        uint256 priceDiff = isUp ? _currentPrice - pos.entryPrice : pos.entryPrice - _currentPrice;
        uint256 loss = (pos.margin * pos.leverage * priceDiff) / pos.entryPrice;
        
        if (loss >= pos.margin) {
            pos.isOpen = false;
            history.push(TradeRecord(_user, pos.margin, pos.entryPrice, _currentPrice, pos.leverage, pos.isLong, pos.margin, false, block.timestamp));
            emit PositionClosed(_user, pos.margin, false);
            // 청산된 원금은 고스란히 거래소(풀)에 회수됩니다.
        } else {
            revert("Position is not bankrupt yet");
        }
    }

    // 금고 잔액 회수 (관리자용)
    function withdrawTips() external onlyOwner {
        (bool success, ) = payable(owner).call{value: address(this).balance}("");
        if (!success) revert TransferFailed();
    }

    function getHistory(uint256 limit) external view returns (TradeRecord[] memory) {
        uint256 count = history.length > limit ? limit : history.length;
        TradeRecord[] memory recent = new TradeRecord[](count);
        for (uint256 i = 0; i < count; i++) {
            recent[i] = history[history.length - 1 - i];
        }
        return recent;
    }

    function getContractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    receive() external payable {}
}
