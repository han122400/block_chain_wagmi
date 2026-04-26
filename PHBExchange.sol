// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title PHBExchange
 * @notice ETH ↔ PHB 교환 컨트랙트
 * @dev 거래 자체는 오프체인(DB)에서 처리되고, 이 컨트랙트는
 *      충전(ETH→PHB)과 인출(PHB→ETH)만 담당합니다.
 *
 * 교환 비율: 0.001 ETH = 10 PHB
 * = 1 ETH = 10,000 PHB
 * = 1 PHB = 0.0001 ETH
 */
contract PHBExchange {
    address public owner;

    // 교환 비율: PHB per 0.001 ETH
    uint256 public constant PHB_PER_UNIT = 10;
    uint256 public constant ETH_UNIT     = 0.001 ether;  // 10 PHB 기준 단위

    // ─── 이벤트 ────────────────────────────────────────────────────────────────
    // 서버(Next.js)가 이벤트를 감지하여 DB에 PHB 잔액을 업데이트합니다.
    event ETHDeposited(
        address indexed user,
        uint256 ethAmount,   // wei 단위
        uint256 phbAmount,   // 지급할 PHB 수량
        uint256 timestamp
    );

    event ETHWithdrawn(
        address indexed user,
        uint256 phbBurned,   // 소각된 PHB
        uint256 ethAmount,   // 전송된 ETH (wei)
        uint256 timestamp
    );

    // ─── 에러 ────────────────────────────────────────────────────────────────
    error OnlyOwner();
    error InvalidETHAmount();       // 0.001 ETH 단위가 아님
    error InsufficientLiquidity();  // 풀 ETH 부족
    error TransferFailed();
    error ZeroAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // [1] ETH 충전 → PHB 지급
    //     반드시 0.001 ETH 단위로만 입금해야 합니다.
    //     예) 0.001 ETH → 10 PHB
    //         0.005 ETH → 50 PHB
    //         0.01 ETH → 100 PHB
    // ─────────────────────────────────────────────────────────────────────────
    function depositETH() external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value % ETH_UNIT != 0) revert InvalidETHAmount();

        uint256 phbAmount = (msg.value / ETH_UNIT) * PHB_PER_UNIT;

        emit ETHDeposited(msg.sender, msg.value, phbAmount, block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // [2] PHB 인출 → ETH 반환 (owner 전용 - 서버 백엔드가 호출)
    //     사용자가 인출 요청하면 서버가 DB에서 PHB를 확인한 뒤
    //     이 함수를 호출하여 ETH를 전송합니다.
    // ─────────────────────────────────────────────────────────────────────────
    function withdrawETHForUser(address user, uint256 phbAmount) external onlyOwner {
        if (phbAmount == 0) revert ZeroAmount();
        if (phbAmount % PHB_PER_UNIT != 0) revert InvalidETHAmount(); // 10 PHB 단위만

        uint256 ethAmount = (phbAmount / PHB_PER_UNIT) * ETH_UNIT;

        if (address(this).balance < ethAmount) revert InsufficientLiquidity();

        emit ETHWithdrawn(user, phbAmount, ethAmount, block.timestamp);

        (bool success, ) = payable(user).call{value: ethAmount}("");
        if (!success) revert TransferFailed();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // [2-B] 사용자 직접 인출 (MetaMask 서명)
    //       사용자가 직접 호출 → ETH가 msg.sender 지갑으로 전송됨
    //       PHB 잔액 검증은 서버 DB에서 담당 (온체인 검증 없음)
    // ─────────────────────────────────────────────────────────────────────────
    function selfWithdraw(uint256 phbAmount) external {
        if (phbAmount == 0) revert ZeroAmount();
        if (phbAmount % PHB_PER_UNIT != 0) revert InvalidETHAmount();

        uint256 ethAmount = (phbAmount / PHB_PER_UNIT) * ETH_UNIT;
        if (address(this).balance < ethAmount) revert InsufficientLiquidity();

        emit ETHWithdrawn(msg.sender, phbAmount, ethAmount, block.timestamp);

        (bool success, ) = payable(msg.sender).call{value: ethAmount}("");
        if (!success) revert TransferFailed();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // [3] 유동성 보충 (owner 전용)
    // ─────────────────────────────────────────────────────────────────────────
    function depositLiquidity() external payable onlyOwner {}

    // ─────────────────────────────────────────────────────────────────────────
    // [4] 조회 함수
    // ─────────────────────────────────────────────────────────────────────────
    function getContractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function ethToPHB(uint256 ethWei) external pure returns (uint256) {
        return (ethWei / ETH_UNIT) * PHB_PER_UNIT;
    }

    function phbToETH(uint256 phbAmount) external pure returns (uint256) {
        return (phbAmount / PHB_PER_UNIT) * ETH_UNIT;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // [5] 긴급 출금 (owner 전용)
    // ─────────────────────────────────────────────────────────────────────────
    function emergencyWithdraw() external onlyOwner {
        (bool success, ) = payable(owner).call{value: address(this).balance}("");
        if (!success) revert TransferFailed();
    }

    receive() external payable {}
}
