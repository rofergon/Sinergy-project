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

function tokenValue(
  bucket: Record<string, string> | undefined,
  address: `0x${string}`,
  decimals: number
) {
  if (!bucket) return "0";
  return formatUnits(BigInt(bucket[address.toLowerCase()] ?? "0"), decimals);
}

export function BalancesPanel({ tokens, balances }: Props) {
  return (
    <section className="panel">
      <div className="panel-header">
        <p className="eyebrow">Dark Vault</p>
        <h2>Internal balances</h2>
      </div>

      <div className="balance-grid">
        {tokens.map((token) => (
          <article className="balance-card" key={token.address}>
            <div>
              <p className="symbol">{token.symbol}</p>
              <p className="muted">{token.name}</p>
            </div>
            <div className="value-group">
              <span>{tokenValue(balances?.available, token.address, token.decimals)}</span>
              <small>available</small>
            </div>
            <div className="value-group">
              <span>{tokenValue(balances?.locked, token.address, token.decimals)}</span>
              <small>locked</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

