import { formatUnits } from "viem";

type Token = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
};

type Props = {
  tokens: Token[];
  balances: {
    available: Record<string, string>;
    locked: Record<string, string>;
  } | null;
};

const TOKEN_COLORS: Record<string, string> = {
  S: "#0ecb81",
  U: "#f0b90b",
  T: "#1e9df2",
  G: "#a855f7",
  B: "#f6465d",
  R: "#7ef0c5",
  D: "#ff8a6b",
};

function tokenColor(symbol: string) {
  const first = symbol.charAt(0).toUpperCase();
  return TOKEN_COLORS[first] ?? "#848e9c";
}

function tokenValue(
  bucket: Record<string, string> | undefined,
  address: `0x${string}`,
  decimals: number
) {
  if (!bucket) return "0.00";
  const val = Number(formatUnits(BigInt(bucket[address.toLowerCase()] ?? "0"), decimals));
  return val.toFixed(val < 1 ? 4 : 2);
}

export function BalancesPanel({ tokens, balances }: Props) {
  return (
    <div className="balances-compact">
      <div className="panel-head" style={{ padding: "0 0 10px", border: "none" }}>
        <span className="panel-title">Balances</span>
      </div>

      {tokens.map((token) => {
        const avail = tokenValue(balances?.available, token.address, token.decimals);
        const locked = tokenValue(balances?.locked, token.address, token.decimals);
        return (
          <div className="bal-row" key={token.address}>
            <div className="bal-token-info">
              <div
                className="bal-token-icon"
                style={{ background: tokenColor(token.symbol) }}
              >
                {token.symbol.charAt(0)}
              </div>
              <div className="bal-token-name">
                <span className="bal-symbol">{token.symbol}</span>
                <span className="bal-fullname">{token.name}</span>
              </div>
            </div>
            <div className="bal-amounts">
              <span className="bal-available">{avail}</span>
              <span className="bal-locked">🔒 {locked}</span>
            </div>
          </div>
        );
      })}

      {tokens.length === 0 && (
        <div style={{ color: "var(--text-tertiary)", fontSize: 12, padding: "16px 0", textAlign: "center" }}>
          Connect wallet to view balances
        </div>
      )}
    </div>
  );
}
