// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @notice Soulbound founder marks (ERC-721 + ERC-5192 "locked"). One mark per wallet per
/// village flag, recording how much RF that wallet locked into the flag. Marks never move:
/// every transfer and approval reverts, so a founder's standing can't be sold. Only the
/// villages contract mints, grows and (on a refund of a failed flag) burns them.
contract DocksFounderMarks {
    error Soulbound();
    error NotVillages();
    error NoMark();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId); // ERC-5192
    event MarkGrew(uint256 indexed tokenId, uint256 locked);

    address public immutable villages;
    string public constant name = "Docks Founder Mark";
    string public constant symbol = "FOUNDER";

    uint256 public totalMinted;
    mapping(uint256 tokenId => address) private _owner;
    mapping(address owner => uint256) public balanceOf;
    mapping(uint256 tokenId => uint256) public villageOfMark;
    mapping(uint256 tokenId => uint256) public lockedOf;
    mapping(uint256 villageId => mapping(address wallet => uint256 tokenId)) public markOf;

    constructor() {
        villages = msg.sender;
    }

    modifier onlyVillages() {
        if (msg.sender != villages) revert NotVillages();
        _;
    }

    /// @dev Mints the wallet's mark for this village, or grows the one it has.
    function add(uint256 villageId, address wallet, uint256 amount)
        external
        onlyVillages
        returns (uint256 tokenId)
    {
        tokenId = markOf[villageId][wallet];
        if (tokenId == 0) {
            tokenId = ++totalMinted;
            markOf[villageId][wallet] = tokenId;
            villageOfMark[tokenId] = villageId;
            _owner[tokenId] = wallet;
            ++balanceOf[wallet];
            emit Transfer(address(0), wallet, tokenId);
            emit Locked(tokenId);
        }
        lockedOf[tokenId] += amount;
        emit MarkGrew(tokenId, lockedOf[tokenId]);
    }

    /// @dev Burns a mark when its RF is refunded from a flag that never filled.
    function burn(uint256 villageId, address wallet) external onlyVillages returns (uint256 amount) {
        uint256 tokenId = markOf[villageId][wallet];
        if (tokenId == 0) revert NoMark();
        amount = lockedOf[tokenId];
        delete markOf[villageId][wallet];
        delete lockedOf[tokenId];
        delete villageOfMark[tokenId];
        delete _owner[tokenId];
        --balanceOf[wallet];
        emit Transfer(wallet, address(0), tokenId);
    }

    /// @notice RF a wallet locked into a village's flag (its founder weight).
    function weightOf(uint256 villageId, address wallet) external view returns (uint256) {
        return lockedOf[markOf[villageId][wallet]];
    }

    function ownerOf(uint256 tokenId) external view returns (address o) {
        o = _owner[tokenId];
        if (o == address(0)) revert NoMark();
    }

    function locked(uint256) external pure returns (bool) {
        return true; // ERC-5192: every mark is soulbound
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owner[tokenId] == address(0)) revert NoMark();
        return string.concat(
            'data:application/json;utf8,{"name":"Founder Mark #',
            _str(tokenId),
            '","description":"Soulbound. Locked ',
            _str(lockedOf[tokenId] / 1 ether),
            ' RF into the flag of village #',
            _str(villageOfMark[tokenId]),
            ' on The Docks.","attributes":[{"trait_type":"Village","value":',
            _str(villageOfMark[tokenId]),
            '},{"trait_type":"RF locked","value":',
            _str(lockedOf[tokenId] / 1 ether),
            "}]}"
        );
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 // ERC-165
            || id == 0x80ac58cd // ERC-721
            || id == 0x5b5e139f // ERC-721 metadata
            || id == 0xb45a3c0e; // ERC-5192
    }

    /* ── soulbound: nothing moves ── */

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function _str(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory b = new bytes(len);
        for (; v != 0; v /= 10) b[--len] = bytes1(uint8(48 + v % 10));
        return string(b);
    }
}
