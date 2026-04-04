import { useEffect, useState, useCallback } from "react";

export type TxPopupType = "success" | "error" | "pending";

export type TxPopupData = {
  type: TxPopupType;
  title: string;
  message: string;
  /** e.g. "0xabc...def" */
  txHash?: string;
  /** e.g. "10 USDC" */
  amount?: string;
  /** e.g. "Deposit" | "Withdraw" | "Swap" | "Order" */
  operation?: string;
  /** auto-dismiss delay in ms (0 = manual only). Default: 6000 */
  duration?: number;
};

type Props = {
  data: TxPopupData | null;
  onClose: () => void;
};

const ICONS: Record<TxPopupType, string> = {
  success: "✓",
  error: "✗",
  pending: "⟳",
};

const LABELS: Record<TxPopupType, string> = {
  success: "Transaction Successful",
  error: "Transaction Failed",
  pending: "Processing…",
};

export function TransactionPopup({ data, onClose }: Props) {
  const [phase, setPhase] = useState<"enter" | "visible" | "exit">("enter");

  const dismiss = useCallback(() => {
    setPhase("exit");
    setTimeout(onClose, 340);
  }, [onClose]);

  useEffect(() => {
    if (!data) return;
    setPhase("enter");

    const enterTimer = setTimeout(() => setPhase("visible"), 20);

    const duration = data.duration ?? 6000;
    let autoTimer: ReturnType<typeof setTimeout> | undefined;
    if (duration > 0) {
      autoTimer = setTimeout(dismiss, duration);
    }

    return () => {
      clearTimeout(enterTimer);
      if (autoTimer) clearTimeout(autoTimer);
    };
  }, [data, dismiss]);

  if (!data) return null;

  const truncateHash = (hash: string) =>
    hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;

  return (
    <div className={`tx-popup-overlay ${phase}`} onClick={dismiss}>
      <div
        className={`tx-popup ${data.type} ${phase}`}
        onClick={(e) => e.stopPropagation()}
        role="alert"
        aria-live="assertive"
      >
        {/* Animated top accent bar */}
        <div className="tx-popup-accent" />

        {/* Close button */}
        <button
          className="tx-popup-close"
          onClick={dismiss}
          aria-label="Close"
        >
          ×
        </button>

        {/* Icon */}
        <div className={`tx-popup-icon ${data.type}`}>
          <span>{ICONS[data.type]}</span>
        </div>

        {/* Header */}
        <div className="tx-popup-header">
          <span className="tx-popup-label">{data.operation ?? LABELS[data.type]}</span>
          <h3 className="tx-popup-title">{data.title}</h3>
        </div>

        {/* Amount badge */}
        {data.amount && (
          <div className="tx-popup-amount">
            {data.amount}
          </div>
        )}

        {/* Message */}
        <p className="tx-popup-message">{data.message}</p>

        {/* Tx hash */}
        {data.txHash && (
          <div className="tx-popup-hash">
            <span className="tx-popup-hash-label">Tx Hash</span>
            <code className="tx-popup-hash-value">{truncateHash(data.txHash)}</code>
          </div>
        )}

        {/* Progress bar for pending */}
        {data.type === "pending" && (
          <div className="tx-popup-progress">
            <div className="tx-popup-progress-bar" />
          </div>
        )}

        {/* Dismiss hint */}
        {data.type !== "pending" && (
          <button className="tx-popup-dismiss-btn" onClick={dismiss}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────
   Hook: simple state manager for popup queue
   ──────────────────────────────────────────────────────── */
export function useTransactionPopup() {
  const [popup, setPopup] = useState<TxPopupData | null>(null);

  const showTx = useCallback((data: TxPopupData) => setPopup(data), []);
  const closeTx = useCallback(() => setPopup(null), []);

  return { popup, showTx, closeTx };
}
