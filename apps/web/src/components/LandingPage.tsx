import { useEffect, useRef, useState } from "react";
import logoDarkUrl from "/SinergyDarkmode.png";
import logoLightUrl from "/Sinergylightmode.png";
import { useTheme } from "../ThemeContext";

type Props = {
  onConnect: () => void;
};

/* ── Animated particle field (canvas background) ── */
function useParticles(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId = 0;
    let particles: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      r: number;
      alpha: number;
    }[] = [];

    function resize() {
      canvas!.width = canvas!.offsetWidth * devicePixelRatio;
      canvas!.height = canvas!.offsetHeight * devicePixelRatio;
    }

    function initParticles() {
      const count = Math.min(80, Math.floor((canvas!.width * canvas!.height) / 18000));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * canvas!.width,
        y: Math.random() * canvas!.height,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        r: Math.random() * 1.5 + 0.5,
        alpha: Math.random() * 0.5 + 0.1,
      }));
    }

    function draw() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = canvas!.width;
        if (p.x > canvas!.width) p.x = 0;
        if (p.y < 0) p.y = canvas!.height;
        if (p.y > canvas!.height) p.y = 0;

        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.r * devicePixelRatio, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(14, 203, 129, ${p.alpha})`;
        ctx!.fill();
      }

      // Draw connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120 * devicePixelRatio) {
            ctx!.beginPath();
            ctx!.moveTo(particles[i].x, particles[i].y);
            ctx!.lineTo(particles[j].x, particles[j].y);
            ctx!.strokeStyle = `rgba(14, 203, 129, ${0.06 * (1 - dist / (120 * devicePixelRatio))})`;
            ctx!.lineWidth = 0.5 * devicePixelRatio;
            ctx!.stroke();
          }
        }
      }

      animId = requestAnimationFrame(draw);
    }

    resize();
    initParticles();
    draw();

    window.addEventListener("resize", () => {
      resize();
      initParticles();
    });

    return () => cancelAnimationFrame(animId);
  }, [canvasRef]);
}

/* ── Feature card icons (inline SVGs) ── */
function ShieldIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="url(#shieldGrad)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <defs>
        <linearGradient id="shieldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0ecb81" />
          <stop offset="100%" stopColor="#1e9df2" />
        </linearGradient>
      </defs>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="url(#brainGrad)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <defs>
        <linearGradient id="brainGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f0b90b" />
          <stop offset="100%" stopColor="#f6465d" />
        </linearGradient>
      </defs>
      <path d="M12 2a4 4 0 0 1 4 4c0 1.1-.9 2-2 2h-4c-1.1 0-2-.9-2-2a4 4 0 0 1 4-4z" />
      <path d="M8 8v2a4 4 0 0 0 8 0V8" />
      <path d="M12 14v8" />
      <path d="M8 18h8" />
      <circle cx="12" cy="6" r="1" fill="url(#brainGrad)" stroke="none" />
      <path d="M7 6C5.3 6.6 4 8.2 4 10c0 2.2 1.8 4 4 4" />
      <path d="M17 6c1.7.6 3 2.2 3 4 0 2.2-1.8 4-4 4" />
    </svg>
  );
}

function RouteIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="url(#routeGrad)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <defs>
        <linearGradient id="routeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1e9df2" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v3c0 2.2 1.8 4 4 4h4c2.2 0 4-1.8 4-4V9" />
      <path d="M18 6v3" />
    </svg>
  );
}

function LockZkIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="url(#zkGrad)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <defs>
        <linearGradient id="zkGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0ecb81" />
          <stop offset="100%" stopColor="#f0b90b" />
        </linearGradient>
      </defs>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      <circle cx="12" cy="16" r="1.5" fill="url(#zkGrad)" stroke="none" />
      <path d="M12 17.5V19" />
    </svg>
  );
}

/* ── Main LandingPage component ── */
export function LandingPage({ onConnect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const { theme } = useTheme();

  useParticles(canvasRef);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(timer);
  }, []);

  const features = [
    {
      icon: <ShieldIcon />,
      title: "Dark Pool Orders",
      desc: "Confidential order flow. Your trade intent stays hidden until settlement.",
      tag: "PRIVACY",
    },
    {
      icon: <LockZkIcon />,
      title: "ZK Vault",
      desc: "Zero-knowledge proofs protect deposits, withdrawals, and balances on-chain.",
      tag: "ZK-SNARK",
    },
    {
      icon: <BrainIcon />,
      title: "AI Strategy Agent",
      desc: "Describe strategies in natural language. The agent builds, validates, and backtests autonomously.",
      tag: "AGENTIC",
    },
    {
      icon: <RouteIcon />,
      title: "Private Router",
      desc: "Cross-chain swaps through InitiaDEX liquidity with no order-book exposure.",
      tag: "ROUTING",
    },
  ];

  return (
    <div className="landing-root">
      <canvas ref={canvasRef} className="landing-particles" />

      {/* Gradient orbs */}
      <div className="landing-orb landing-orb-1" />
      <div className="landing-orb landing-orb-2" />
      <div className="landing-orb landing-orb-3" />

      <div className={`landing-content ${visible ? "landing-visible" : ""}`}>
        {/* Minimal landing header */}
        <nav className="landing-navbar">
          <div className="landing-nav-logo">
            <img
              className="landing-nav-mark"
              src={theme === "dark" ? logoDarkUrl : logoLightUrl}
              alt="Sinergy"
            />
          </div>
          <div className="landing-nav-right">
            <span className="landing-nav-testnet">Testnet</span>
            <button className="landing-nav-connect" onClick={onConnect} id="landing-nav-connect-btn">
              Connect Wallet
            </button>
          </div>
        </nav>

        {/* Hero */}
        <section className="landing-hero">
          <div className="landing-badge">
            <span className="landing-badge-dot" />
            Built on Initia — Interwoven Rollup
          </div>

          <h1 className="landing-title">
            Trade privately.
            <br />
            <span className="landing-title-accent">Think agentically.</span>
          </h1>

          <p className="landing-subtitle">
            Sinergy is a confidential DEX with zero-knowledge vaults, dark pool order flow, and an AI agent that builds and backtests trading strategies from natural language.
          </p>

          <div className="landing-cta-group">
            <button className="landing-cta-primary" onClick={onConnect} id="landing-connect-btn">
              <span className="landing-cta-glow" />
              Connect Wallet
            </button>
            <a
              className="landing-cta-secondary"
              href="https://docs.sinergy.dev"
              target="_blank"
              rel="noopener noreferrer"
              id="landing-docs-link"
            >
              Read the docs →
            </a>
          </div>

          {/* Stats strip */}
          <div className="landing-stats">
            <div className="landing-stat">
              <strong>ZK-SNARK</strong>
              <span>Vault proofs</span>
            </div>
            <div className="landing-stat-divider" />
            <div className="landing-stat">
              <strong>Dark Pool</strong>
              <span>Hidden order flow</span>
            </div>
            <div className="landing-stat-divider" />
            <div className="landing-stat">
              <strong>AI Agent</strong>
              <span>Autonomous strategies</span>
            </div>
            <div className="landing-stat-divider" />
            <div className="landing-stat">
              <strong>MiniEVM</strong>
              <span>Interwoven rollup</span>
            </div>
          </div>
        </section>

        {/* Features grid */}
        <section className="landing-features">
          {features.map((feature, index) => (
            <div
              key={feature.title}
              className="landing-feature-card"
              style={{ animationDelay: `${0.15 + index * 0.1}s` }}
            >
              <div className="landing-feature-icon">{feature.icon}</div>
              <span className="landing-feature-tag">{feature.tag}</span>
              <h3 className="landing-feature-title">{feature.title}</h3>
              <p className="landing-feature-desc">{feature.desc}</p>
            </div>
          ))}
        </section>

        {/* Architecture visual */}
        <section className="landing-arch">
          <div className="landing-arch-card">
            <div className="landing-arch-row">
              <div className="landing-arch-node">
                <span className="landing-arch-label">User</span>
                <span className="landing-arch-sub">Wallet</span>
              </div>
              <div className="landing-arch-arrow">→</div>
              <div className="landing-arch-node highlight-privacy">
                <span className="landing-arch-label">ZK Vault</span>
                <span className="landing-arch-sub">Commitments</span>
              </div>
              <div className="landing-arch-arrow">→</div>
              <div className="landing-arch-node highlight-agent">
                <span className="landing-arch-label">Dark Pool</span>
                <span className="landing-arch-sub">Matcher</span>
              </div>
              <div className="landing-arch-arrow">→</div>
              <div className="landing-arch-node highlight-route">
                <span className="landing-arch-label">Settlement</span>
                <span className="landing-arch-sub">MiniEVM</span>
              </div>
            </div>
            <div className="landing-arch-caption">
              End-to-end confidential — from deposit to settlement, your data stays yours.
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="landing-footer">
          <span>Sinergy Protocol — Confidential RWA Dark Pool on Initia</span>
          <span className="landing-footer-dot" />
          <span>Testnet</span>
        </footer>
      </div>
    </div>
  );
}
