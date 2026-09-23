export const VaultDirectoryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "initialOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "get",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct VaultDirectory.Entry",
        "components": [
          {
            "name": "hourly",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "daily",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "weekly",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "monthly",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "registry",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "router",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "usdg",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "weth",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "dca",
            "type": "address",
            "internalType": "address"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingOwner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "set",
    "inputs": [
      {
        "name": "e",
        "type": "tuple",
        "internalType": "struct VaultDirectory.Entry",
        "components": [
          {
            "name": "hourly",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "daily",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "weekly",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "monthly",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "registry",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "router",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "usdg",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "weth",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "dca",
            "type": "address",
            "internalType": "address"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "vaults",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address[4]",
        "internalType": "address[4]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "DirectorySet",
    "inputs": [
      {
        "name": "entry",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct VaultDirectory.Entry",
        "components": [
          {
            "name": "hourly",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "daily",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "weekly",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "monthly",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "registry",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "router",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "usdg",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "weth",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "dca",
            "type": "address",
            "internalType": "address"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferStarted",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  }
] as const;
