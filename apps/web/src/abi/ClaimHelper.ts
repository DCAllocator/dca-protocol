export const ClaimHelperAbi = [
  {
    "type": "function",
    "name": "claimable",
    "inputs": [
      {
        "name": "vaults",
        "type": "address[]",
        "internalType": "contract IPlanVault[]"
      },
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "stock",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "total",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "positions",
    "inputs": [
      {
        "name": "vaults",
        "type": "address[]",
        "internalType": "contract IPlanVault[]"
      },
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "out",
        "type": "tuple[]",
        "internalType": "struct ClaimHelper.Position[]",
        "components": [
          {
            "name": "vault",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "planId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "stock",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amountPerEpoch",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "usdgIdle",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "stockAccrued",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "lastEpochId",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "paused",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "previewFee",
    "inputs": [
      {
        "name": "vault",
        "type": "address",
        "internalType": "contract IPlanVault"
      },
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amountPerEpoch",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "feeUsdg",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "feeBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "autoDistribute",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "previewFill",
    "inputs": [
      {
        "name": "vault",
        "type": "address",
        "internalType": "contract IPlanVault"
      },
      {
        "name": "planId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "spendUsdg",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "feeUsdg",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "feeBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "autoDistribute",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  }
] as const;
