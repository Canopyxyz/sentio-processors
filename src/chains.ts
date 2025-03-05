export enum SupportedAptosChainId {
  JESTNET = 0, // used for jest testing
  APTOS_MAINNET = 1,
  APTOS_TESTNET = 2,
  MOVEMENT_MAINNET = 126,
  APTOS_DEVNET = 148,
  MOVEMENT_PORTO = 177,
}

export function isSupportedAptosChainId(chainId: number): chainId is SupportedAptosChainId {
  return Object.values(SupportedAptosChainId)
    .filter((value): value is number => typeof value === "number")
    .includes(chainId);
}

export function getSupportedAptosChainId(chainId: number): SupportedAptosChainId {
  if (isSupportedAptosChainId(chainId)) {
    return chainId;
  }
  throw new Error(`Unsupported Aptos chain ID: ${chainId}`);
}
