import { useEffect, useRef, useState, useCallback } from "react";

export type TxPopupType = "success" | "error" | "pending" | "bridge-success";

export type TxPopupData = {
  type: TxPopupType;
  title: string;
  message: string;
  /** e.g. "0xabc...def" */
  txHash?: string;
  /** e.g. "10 USDC" */
  amount?: string;
  /** e.g. "Deposit" | "Withdraw" | "Swap" | "Order" | "Bridge" */
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
  "bridge-success": "🌉",
};

const LABELS: Record<TxPopupType, string> = {
  success: "Transaction Successful",
  error: "Transaction Failed",
  pending: "Processing…",
  "bridge-success": "Bridge Completed",
};

/* ── Confetti particle ── */
type Particle = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  rotation: number;
  rotationSpeed: number;
  shape: "square" | "circle" | "triangle";
  opacity: number;
  life: number;
};

const CONFETTI_COLORS = [
  "#0ecb81", "#2bdba7", "#1e9df2", "#f0b90b",
  "#a78bfa", "#34d399", "#60a5fa", "#fbbf24",
];

function createParticle(id: number, containerW: number, containerH: number): Particle {
  return {
    id,
    x: Math.random() * containerW,
    y: -10,
    vx: (Math.random() - 0.5) * 4,
    vy: Math.random() * 3 + 1.5,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    size: Math.random() * 8 + 5,
    rotation: Math.random() * 360,
    rotationSpeed: (Math.random() - 0.5) * 8,
    shape: (["square", "circle", "triangle"] as const)[Math.floor(Math.random() * 3)],
    opacity: 1,
    life: 1,
  };
}

function ConfettiCanvas({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const spawnCountRef = useRef(0);
  const frameRef = useRef(0);

  useEffect(() => {
    if (!active) {
      cancelAnimationFrame(animRef.current);
      particlesRef.current = [];
      spawnCountRef.current = 0;
      frameRef.current = 0;
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    function drawParticle(p: Particle) {
      ctx!.save();
      ctx!.globalAlpha = p.opacity;
      ctx!.fillStyle = p.color;
      ctx!.translate(p.x, p.y);
      ctx!.rotate((p.rotation * Math.PI) / 180);

      if (p.shape === "square") {
        ctx!.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      } else if (p.shape === "circle") {
        ctx!.beginPath();
        ctx!.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx!.fill();
      } else {
        ctx!.beginPath();
        ctx!.moveTo(0, -p.size / 2);
        ctx!.lineTo(p.size / 2, p.size / 2);
        ctx!.lineTo(-p.size / 2, p.size / 2);
        ctx!.closePath();
        ctx!.fill();
      }
      ctx!.restore();
    }

    function tick() {
      ctx!.clearRect(0, 0, W, H);
      frameRef.current += 1;

      // Spawn burst in first 40 frames
      if (frameRef.current <= 40 && spawnCountRef.current < 80) {
        const toSpawn = frameRef.current <= 10 ? 6 : 2;
        for (let i = 0; i < toSpawn && spawnCountRef.current < 80; i++) {
          particlesRef.current.push(createParticle(spawnCountRef.current++, W, H));
        }
      }

      particlesRef.current = particlesRef.current.filter((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.06; // gravity
        p.vx *= 0.99; // air resistance
        p.rotation += p.rotationSpeed;
        p.life -= 0.008;
        p.opacity = Math.max(0, p.life);
        drawParticle(p);
        return p.life > 0 && p.y < H + 20;
      });

      if (particlesRef.current.length > 0 || frameRef.current <= 40) {
        animRef.current = requestAnimationFrame(tick);
      }
    }

    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      width={400}
      height={520}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        borderRadius: "20px",
        overflow: "hidden",
      }}
    />
  );
}

export function TransactionPopup({ data, onClose }: Props) {
  const [phase, setPhase] = useState<"enter" | "visible" | "exit">("enter");
  const [confettiActive, setConfettiActive] = useState(false);

  const dismiss = useCallback(() => {
    setPhase("exit");
    setConfettiActive(false);
    setTimeout(onClose, 340);
  }, [onClose]);

  useEffect(() => {
    if (!data) return;
    setPhase("enter");
    setConfettiActive(false);

    const enterTimer = setTimeout(() => {
      setPhase("visible");
      if (data.type === "bridge-success") {
        // Small delay so popup is visible before confetti
        setTimeout(() => setConfettiActive(true), 200);
      }
    }, 20);

    const duration = data.duration ?? (data.type === "bridge-success" ? 8000 : 6000);
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

  const isBridgeSuccess = data.type === "bridge-success";

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
        {/* Confetti canvas for bridge-success */}
        {isBridgeSuccess && <ConfettiCanvas active={confettiActive} />}

        {/* Bridge success glow backdrop */}
        {isBridgeSuccess && <div className="tx-popup-bridge-glow" />}

        {/* Animated top accent bar */}
        <div className="tx-popup-accent">
          {isBridgeSuccess && <div className="tx-popup-accent-shimmer" />}
        </div>

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
          {isBridgeSuccess ? (
            <>
              <div className="tx-popup-bridge-ripple" />
              <div className="tx-popup-bridge-ripple tx-popup-bridge-ripple--2" />
              <span className="tx-popup-bridge-icon-inner">{ICONS[data.type]}</span>
            </>
          ) : (
            <span>{ICONS[data.type]}</span>
          )}
        </div>

        {/* Header */}
        <div className="tx-popup-header">
          <span className="tx-popup-label">
            {isBridgeSuccess ? "✦ Bridge Completed ✦" : (data.operation ?? LABELS[data.type])}
          </span>
          <h3 className="tx-popup-title">{data.title}</h3>
        </div>

        {/* Amount badge */}
        {data.amount && (
          <div className={`tx-popup-amount ${isBridgeSuccess ? "tx-popup-amount--bridge" : ""}`}>
            {isBridgeSuccess && <span className="tx-popup-amount-arrow">↗</span>}
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

        {/* Bridge success step trail */}
        {isBridgeSuccess && (
          <div className="tx-popup-bridge-steps">
            <div className="tx-popup-bridge-step tx-popup-bridge-step--done">
              <span className="tx-popup-bridge-step-dot" />
              <span>Deposit signed</span>
            </div>
            <div className="tx-popup-bridge-step-line" />
            <div className="tx-popup-bridge-step tx-popup-bridge-step--done">
              <span className="tx-popup-bridge-step-dot" />
              <span>Settlement confirmed</span>
            </div>
            <div className="tx-popup-bridge-step-line" />
            <div className="tx-popup-bridge-step tx-popup-bridge-step--done tx-popup-bridge-step--active">
              <span className="tx-popup-bridge-step-dot" />
              <span>Arrived on Sinergy ✓</span>
            </div>
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
          <button
            className={`tx-popup-dismiss-btn ${isBridgeSuccess ? "tx-popup-dismiss-btn--bridge" : ""}`}
            onClick={dismiss}
          >
            {isBridgeSuccess ? "🚀 Go to Exchange" : "Dismiss"}
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
