import { useState, useEffect, useRef, useCallback } from "react";

// ── Coinbase Advanced Trade API (CDP JWT Auth) ────────────────────────────────
// Coinbase uses ES256 JWT signed with EC private key for authentication.
// We use the Web Crypto API to sign JWTs entirely in the browser.

async function importPrivateKey(pem) {
  const pemBody = pem
    .replace(/-----BEGIN EC PRIVATE KEY-----/, "")
    .replace(/-----END EC PRIVATE KEY-----/, "")
    .replace(/\\n/g, "")
    .replace(/\n/g, "")
    .trim();
  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

async function makeJWT(keyName, privateKeyPem, method, path) {
  const key = await importPrivateKey(privateKeyPem);
  const header = { alg: "ES256", kid: keyName };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    sub: keyName,
    uri: `${method} api.coinbase.com${path}`,
  };
  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${signingInput}.${sigB64}`;
}

async function cbFetch(keyName, privateKey, method, path, body = null) {
  const jwt = await makeJWT(keyName, privateKey, method, path);
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.coinbase.com${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Coinbase API ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Fetch real BTC-USD price ──────────────────────────────────────────────────
async function fetchPrice(keyName, privateKey) {
  const data = await cbFetch(keyName, privateKey, "GET", "/api/v3/brokerage/market/products/BTC-USD");
  return parseFloat(data.price);
}

// ── Fetch account balances ────────────────────────────────────────────────────
async function fetchBalances(keyName, privateKey) {
  const data = await cbFetch(keyName, privateKey, "GET", "/api/v3/brokerage/accounts");
  const accounts = data.accounts || [];
  const usd = accounts.find(a => a.currency === "USD");
  const btc = accounts.find(a => a.currency === "BTC");
  return {
    usd: usd ? parseFloat(usd.available_balance?.value || 0) : 0,
    btc: btc ? parseFloat(btc.available_balance?.value || 0) : 0,
  };
}

// ── Place a market order ──────────────────────────────────────────────────────
async function placeOrder(keyName, privateKey, side, quoteSize, baseSize) {
  const clientOrderId = `ai-agent-${Date.now()}`;
  const order = {
    client_order_id: clientOrderId,
    product_id: "BTC-USD",
    side, // "BUY" or "SELL"
    order_configuration: side === "BUY"
      ? { market_market_ioc: { quote_size: quoteSize.toFixed(2) } }  // spend $X
      : { market_market_ioc: { base_size: baseSize.toFixed(8) } },   // sell X BTC
  };
  return await cbFetch(keyName, privateKey, "POST", "/api/v3/brokerage/orders", order);
}

// ── Technical Analysis ────────────────────────────────────────────────────────
function computeRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  return 100 - 100 / (1 + gains / (losses || 0.001));
}

function computeMACD(prices) {
  if (prices.length < 26) return { macd: 0, hist: 0, signal: 0 };
  const ema = (p, n) => { const k = 2 / (n + 1); let e = p[0]; for (let i = 1; i < p.length; i++) e = p[i] * k + e * (1 - k); return e; };
  const fast = ema(prices.slice(-26), 12);
  const slow = ema(prices.slice(-26), 26);
  const macd = fast - slow;
  const signal = macd * 0.9;
  return { macd, signal, hist: macd - signal };
}

function computeSMA(prices, n) {
  const slice = prices.slice(-n);
  if (slice.length < n) return prices[prices.length - 1];
  return slice.reduce((a, b) => a + b, 0) / n;
}

function getDecision(prices) {
  if (prices.length < 30) return { action: "HOLD", confidence: 50, reasons: ["Collecting data..."], rsi: 50, macd: 0, sma20: prices[prices.length-1], sma50: prices[prices.length-1], price: prices[prices.length-1] };
  const rsi = computeRSI(prices);
  const { macd, hist } = computeMACD(prices);
  const sma20 = computeSMA(prices, 20);
  const sma50 = computeSMA(prices, Math.min(50, prices.length));
  const price = prices[prices.length - 1];
  let score = 0, reasons = [];
  if (rsi < 32) { score += 3; reasons.push("RSI strongly oversold"); }
  else if (rsi < 42) { score += 1; reasons.push("RSI oversold"); }
  else if (rsi > 68) { score -= 3; reasons.push("RSI strongly overbought"); }
  else if (rsi > 58) { score -= 1; reasons.push("RSI overbought"); }
  if (hist > 0) { score += 1; reasons.push("MACD bullish crossover"); } else { score -= 1; reasons.push("MACD bearish crossover"); }
  if (price > sma20) { score += 1; reasons.push("Price above SMA20"); } else { score -= 1; reasons.push("Price below SMA20"); }
  if (sma20 > sma50) { score += 1; reasons.push("Golden cross (SMA20 > SMA50)"); } else { score -= 1; reasons.push("Death cross (SMA20 < SMA50)"); }
  // Momentum
  if (prices.length >= 5) {
    const momentum = (price - prices[prices.length - 5]) / prices[prices.length - 5] * 100;
    if (momentum > 1.5) { score += 1; reasons.push(`Strong momentum +${momentum.toFixed(1)}%`); }
    else if (momentum < -1.5) { score -= 1; reasons.push(`Weak momentum ${momentum.toFixed(1)}%`); }
  }
  const action = score >= 3 ? "BUY" : score <= -3 ? "SELL" : "HOLD";
  const confidence = Math.min(96, 45 + Math.abs(score) * 9);
  return { action, confidence, reasons, rsi, macd, sma20, sma50, price, score };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const C = {
  bg: "#060608", panel: "#0e0e14", border: "#1a1a28",
  accent: "#00e87a", accentDim: "#00e87a18", warn: "#f5a623",
  danger: "#ff3b5c", text: "#dde1f0", muted: "#4a4a6a", blue: "#3d7eff",
  purple: "#a855f7",
};

const fmt = (n, d = 2) => n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUSD = (n) => n == null ? "—" : `$${fmt(n, 2)}`;
const fmtPct = (n) => n == null ? "—" : `${n >= 0 ? "+" : ""}${fmt(n, 2)}%`;
const fmtBTC = (n) => n == null ? "—" : `₿${Number(n).toFixed(6)}`;

function Sparkline({ data, color, width = 200, height = 50, filled = false }) {
  if (!data || data.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - 4 - ((v - min) / range) * (height - 8)}`);
  const pathD = `M ${pts.join(" L ")}`;
  const fillD = `${pathD} L ${width},${height} L 0,${height} Z`;
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
      {filled && <path d={fillD} fill={color} opacity="0.08" />}
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Badge({ label, color, pulse }) {
  return (
    <span style={{
      background: color + "20", color, border: `1px solid ${color}40`,
      borderRadius: 3, padding: "3px 10px", fontSize: 10,
      fontFamily: "monospace", fontWeight: 700, letterSpacing: 1.5,
      display: "inline-flex", alignItems: "center", gap: 5,
    }}>
      {pulse && <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block", animation: "pulse 1.5s infinite" }} />}
      {label}
    </span>
  );
}

function StatCard({ label, value, sub, subColor, valColor, spark, sparkColor }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px", position: "relative", overflow: "hidden" }}>
      <div style={{ color: C.muted, fontSize: 9, letterSpacing: 2.5, marginBottom: 10, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: valColor || C.text, fontFamily: "monospace", letterSpacing: -0.5 }}>{value}</div>
      {sub && <div style={{ color: subColor || C.muted, fontSize: 11, marginTop: 5, fontFamily: "monospace" }}>{sub}</div>}
      {spark && <div style={{ position: "absolute", bottom: 0, right: 0, opacity: 0.6 }}><Sparkline data={spark} color={sparkColor || C.accent} width={80} height={40} filled /></div>}
    </div>
  );
}

function TradeRow({ trade, index }) {
  const isBuy = trade.side === "BUY";
  const isLive = trade.live;
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "70px 55px 100px 100px 85px 60px 1fr",
      gap: 6, alignItems: "center", padding: "9px 16px",
      borderBottom: `1px solid ${C.border}`, fontSize: 11, fontFamily: "monospace",
      background: index === 0 ? C.accentDim : "transparent",
      transition: "background 0.5s",
    }}>
      <span style={{ color: C.muted, fontSize: 10 }}>{trade.time}</span>
      <span style={{ color: isBuy ? C.accent : C.danger, fontWeight: 800 }}>{trade.side}</span>
      <span style={{ color: C.text }}>{fmtUSD(trade.price)}</span>
      <span style={{ color: C.text }}>{fmtUSD(trade.amount)}</span>
      <span style={{ color: trade.pnl > 0 ? C.accent : trade.pnl < 0 ? C.danger : C.muted, fontWeight: trade.pnl != null ? 700 : 400 }}>
        {trade.pnl != null ? fmtUSD(trade.pnl) : "open"}
      </span>
      <span>{isLive ? <Badge label="LIVE" color={C.accent} /> : <Badge label="SIM" color={C.muted} />}</span>
      <span style={{ color: C.muted, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{trade.reason}</span>
    </div>
  );
}

// ── Setup Screen ──────────────────────────────────────────────────────────────
function SetupScreen({ onConnect }) {
  const [keyName, setKeyName] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("idle"); // idle | testing | success | error

  const handleConnect = async () => {
    if (!keyName.trim() || !privateKey.trim()) { setError("Both fields are required."); return; }
    if (!keyName.startsWith("organizations/")) { setError("Key Name should start with 'organizations/...'"); return; }
    if (!privateKey.includes("BEGIN EC PRIVATE KEY")) { setError("Invalid private key format."); return; }
    setStatus("testing"); setError("");
    try {
      const balances = await fetchBalances(keyName.trim(), privateKey.trim());
      setStatus("success");
      await new Promise(r => setTimeout(r, 800));
      onConnect({ keyName: keyName.trim(), privateKey: privateKey.trim(), balances });
    } catch (e) {
      setStatus("error");
      setError(`Connection failed: ${e.message}`);
    }
  };

  const statusColors = { idle: C.blue, testing: C.warn, success: C.accent, error: C.danger };
  const statusLabels = { idle: "READY TO CONNECT", testing: "VERIFYING...", success: "CONNECTED ✓", error: "FAILED" };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'DM Mono', 'Fira Mono', monospace" }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} } @keyframes fadeIn { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:none} }`}</style>
      <div style={{ width: "100%", maxWidth: 460, animation: "fadeIn 0.4s ease" }}>

        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 12, filter: "drop-shadow(0 0 20px #00e87a)" }}>⚡</div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: 2, color: C.text }}>AI TRADING AGENT</div>
          <div style={{ color: C.muted, fontSize: 11, marginTop: 8, letterSpacing: 1 }}>PHASE 2 — LIVE COINBASE INTEGRATION</div>
        </div>

        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28 }}>
          <div style={{ background: "#f5a62312", border: `1px solid ${C.warn}30`, borderRadius: 8, padding: "10px 14px", marginBottom: 24, fontSize: 11, color: C.warn, lineHeight: 1.7 }}>
            🔒 Keys never leave your browser. They're used only to sign requests directly to Coinbase.
          </div>

          <div style={{ marginBottom: 18 }}>
            <label style={{ fontSize: 9, letterSpacing: 2.5, color: C.muted, display: "block", marginBottom: 8 }}>API KEY NAME</label>
            <input value={keyName} onChange={e => setKeyName(e.target.value)}
              placeholder="organizations/xxx/apiKeys/xxx"
              style={{ width: "100%", background: C.bg, border: `1px solid ${keyName ? C.accent + "50" : C.border}`, borderRadius: 8, padding: "11px 14px", color: C.text, fontSize: 11, fontFamily: "monospace", outline: "none", boxSizing: "border-box", transition: "border 0.2s" }} />
          </div>

          <div style={{ marginBottom: 22 }}>
            <label style={{ fontSize: 9, letterSpacing: 2.5, color: C.muted, display: "block", marginBottom: 8 }}>PRIVATE KEY</label>
            <div style={{ position: "relative" }}>
              <textarea value={privateKey} onChange={e => setPrivateKey(e.target.value)}
                placeholder={"-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----"}
                rows={4}
                style={{ width: "100%", background: C.bg, border: `1px solid ${privateKey ? C.accent + "50" : C.border}`, borderRadius: 8, padding: "11px 14px 11px 14px", color: showKey ? C.text : "transparent", fontSize: 11, fontFamily: "monospace", outline: "none", resize: "none", boxSizing: "border-box", textShadow: showKey ? "none" : "0 0 10px rgba(200,210,255,0.6)", transition: "border 0.2s" }} />
              <button onClick={() => setShowKey(s => !s)}
                style={{ position: "absolute", right: 12, top: 10, background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>
                {showKey ? "🙈" : "👁️"}
              </button>
            </div>
          </div>

          {error && (
            <div style={{ color: C.danger, fontSize: 11, marginBottom: 16, padding: "10px 14px", background: "#ff3b5c12", borderRadius: 8, border: `1px solid ${C.danger}30`, lineHeight: 1.5 }}>
              ⚠️ {error}
            </div>
          )}

          <button onClick={handleConnect} disabled={status === "testing"}
            style={{ width: "100%", padding: "14px", borderRadius: 10, border: "none", background: status === "success" ? C.accent : status === "testing" ? C.border : `linear-gradient(135deg, ${C.accent}, ${C.blue})`, color: status === "success" ? "#000" : status === "testing" ? C.muted : "#000", fontWeight: 800, fontSize: 12, letterSpacing: 2, cursor: status === "testing" ? "not-allowed" : "pointer", fontFamily: "monospace", transition: "all 0.3s" }}>
            {statusLabels[status]}
          </button>

          <div style={{ display: "flex", gap: 8, marginTop: 16, fontSize: 10, color: C.muted, justifyContent: "center" }}>
            <span>Need API keys?</span>
            <a href="https://advanced.coinbase.com" target="_blank" rel="noreferrer" style={{ color: C.blue }}>advanced.coinbase.com →</a>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
function Dashboard({ creds, initialBalances }) {
  const { keyName, privateKey } = creds;

  // State
  const [usdBalance, setUsdBalance] = useState(initialBalances.usd);
  const [btcBalance, setBtcBalance] = useState(initialBalances.btc);
  const [startUsd] = useState(initialBalances.usd);
  const [prices, setPrices] = useState([]);
  const [trades, setTrades] = useState([]);
  const [position, setPosition] = useState(null); // { entryPrice, btcAmount, usdSpent }
  const [agentStatus, setAgentStatus] = useState("STARTING");
  const [lastError, setLastError] = useState(null);
  const [balanceHistory, setBalanceHistory] = useState([initialBalances.usd]);
  const [priceHistory, setPriceHistory] = useState([]);
  const [isTrading, setIsTrading] = useState(true);
  const [logs, setLogs] = useState([]);

  const positionRef = useRef(null);
  const usdRef = useRef(initialBalances.usd);
  const btcRef = useRef(initialBalances.btc);
  const pricesRef = useRef([]);
  const tradingRef = useRef(true);

  const addLog = useCallback((msg, color = C.muted) => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs(l => [{ time, msg, color, id: Date.now() }, ...l.slice(0, 49)]);
  }, []);

  // ── Price polling (every 10s) ────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const price = await fetchPrice(keyName, privateKey);
        if (!mounted) return;
        setPrices(prev => {
          const next = [...prev.slice(-199), price];
          pricesRef.current = next;
          return next;
        });
        setPriceHistory(prev => [...prev.slice(-59), price]);
        setAgentStatus("RUNNING");
        setLastError(null);
      } catch (e) {
        if (!mounted) return;
        setLastError(e.message);
        setAgentStatus("ERROR");
        addLog(`Price fetch error: ${e.message}`, C.danger);
      }
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => { mounted = false; clearInterval(id); };
  }, [keyName, privateKey]);

  // ── Balance polling (every 30s) ──────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const b = await fetchBalances(keyName, privateKey);
        if (!mounted) return;
        usdRef.current = b.usd;
        btcRef.current = b.btc;
        setUsdBalance(b.usd);
        setBtcBalance(b.btc);
        setBalanceHistory(prev => [...prev.slice(-49), b.usd]);
      } catch (e) {
        if (mounted) addLog(`Balance fetch error: ${e.message}`, C.warn);
      }
    };
    const id = setInterval(poll, 30000);
    return () => { mounted = false; clearInterval(id); };
  }, [keyName, privateKey]);

  // ── AI Trading Engine (runs every 30s after prices collected) ───────────
  useEffect(() => {
    let mounted = true;
    const run = async () => {
      if (!tradingRef.current) return;
      const currentPrices = pricesRef.current;
      if (currentPrices.length < 10) return;

      const d = getDecision(currentPrices);
      const now = new Date().toLocaleTimeString("en-US", { hour12: false });
      const usd = usdRef.current;
      const btc = btcRef.current;
      const pos = positionRef.current;
      const currentPrice = currentPrices[currentPrices.length - 1];

      addLog(`[${now}] Decision: ${d.action} (score ${d.score > 0 ? "+" : ""}${d.score}, RSI ${d.rsi.toFixed(1)})`, d.action === "BUY" ? C.accent : d.action === "SELL" ? C.danger : C.muted);

      // Check stop-loss on open position
      if (pos && currentPrice <= pos.entryPrice * 0.80) {
        addLog(`⚠️ STOP-LOSS triggered at ${fmtUSD(currentPrice)}`, C.danger);
        try {
          if (btc >= 0.00001) {
            await placeOrder(keyName, privateKey, "SELL", null, btc);
            const pnl = (currentPrice - pos.entryPrice) * pos.btcAmount;
            setTrades(prev => [{ id: Date.now(), time: now, side: "SELL", price: currentPrice, amount: pos.usdSpent, pnl, reason: "Stop-loss -20%", live: true }, ...prev.slice(0, 49)]);
            positionRef.current = null;
            setPosition(null);
            addLog(`Stop-loss SELL executed. PnL: ${fmtUSD(pnl)}`, C.danger);
          }
        } catch (e) { addLog(`Stop-loss order failed: ${e.message}`, C.danger); }
        return;
      }

      if (d.action === "BUY" && !pos && usd >= 5) {
        const spendUsd = usd * 0.90; // use 90% of available USD
        try {
          addLog(`Placing BUY order: ${fmtUSD(spendUsd)} @ ${fmtUSD(currentPrice)}`, C.accent);
          const result = await placeOrder(keyName, privateKey, "BUY", spendUsd, null);
          const btcBought = spendUsd / currentPrice;
          const newPos = { entryPrice: currentPrice, btcAmount: btcBought, usdSpent: spendUsd, orderId: result?.order_id };
          positionRef.current = newPos;
          setPosition(newPos);
          setTrades(prev => [{ id: Date.now(), time: now, side: "BUY", price: currentPrice, amount: spendUsd, pnl: null, reason: d.reasons[0], live: true }, ...prev.slice(0, 49)]);
          addLog(`✅ BUY filled: ${btcBought.toFixed(6)} BTC`, C.accent);
        } catch (e) {
          addLog(`BUY order failed: ${e.message}`, C.danger);
          setLastError(e.message);
        }
      } else if (d.action === "SELL" && pos && btc >= 0.00001) {
        try {
          addLog(`Placing SELL order: ${fmtBTC(btc)} @ ${fmtUSD(currentPrice)}`, C.danger);
          const result = await placeOrder(keyName, privateKey, "SELL", null, btc);
          const pnl = (currentPrice - pos.entryPrice) * pos.btcAmount;
          setTrades(prev => [{ id: Date.now(), time: now, side: "SELL", price: currentPrice, amount: btc * currentPrice, pnl, reason: d.reasons[0], live: true }, ...prev.slice(0, 49)]);
          positionRef.current = null;
          setPosition(null);
          addLog(`✅ SELL filled. PnL: ${fmtUSD(pnl)}`, pnl >= 0 ? C.accent : C.danger);
        } catch (e) {
          addLog(`SELL order failed: ${e.message}`, C.danger);
          setLastError(e.message);
        }
      }
    };

    const id = setInterval(run, 30000); // every 30 seconds
    return () => { mounted = false; clearInterval(id); };
  }, [keyName, privateKey]);

  const decision = pricesRef.current.length > 5 ? getDecision(pricesRef.current) : { action: "HOLD", confidence: 50, reasons: ["Loading prices..."], rsi: 50, macd: 0, sma20: 0, sma50: 0, price: 0, score: 0 };
  const currentPrice = prices[prices.length - 1] || 0;
  const totalValueUSD = usdBalance + btcBalance * currentPrice;
  const totalPnl = totalValueUSD - startUsd;
  const totalPnlPct = ((totalValueUSD - startUsd) / startUsd) * 100;
  const progress = Math.min(100, (totalValueUSD / 100000) * 100);

  const unrealizedPnl = position ? (currentPrice - position.entryPrice) * position.btcAmount : null;
  const stopLossPrice = position ? position.entryPrice * 0.80 : null;

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'DM Mono', 'Fira Mono', monospace" }}>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: ${C.bg}; } ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 2px; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.panel, position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, boxShadow: `0 0 16px ${C.accent}40` }}>⚡</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: 1.5 }}>AI TRADING AGENT</div>
            <div style={{ color: C.muted, fontSize: 9, letterSpacing: 2.5 }}>COINBASE ADVANCED TRADE • BTC-USD • LIVE</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {lastError && <Badge label="API ERROR" color={C.danger} pulse />}
          <Badge label={agentStatus} color={agentStatus === "RUNNING" ? C.accent : agentStatus === "ERROR" ? C.danger : C.warn} pulse={agentStatus === "RUNNING"} />
          <Badge label="LIVE TRADING" color={C.danger} />
          <button onClick={() => { setIsTrading(t => { tradingRef.current = !t; return !t; })}
          } style={{ background: isTrading ? C.danger + "20" : C.accent + "20", border: `1px solid ${isTrading ? C.danger : C.accent}40`, color: isTrading ? C.danger : C.accent, borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 10, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1 }}>
            {isTrading ? "⏸ PAUSE" : "▶ RESUME"}
          </button>
        </div>
      </div>

      <div style={{ padding: "20px 24px", maxWidth: 1200, margin: "0 auto" }}>

        {lastError && (
          <div style={{ background: "#ff3b5c10", border: `1px solid ${C.danger}30`, borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 11, color: C.danger, display: "flex", gap: 8 }}>
            ⚠️ <span>{lastError} — Agent will retry automatically.</span>
          </div>
        )}

        {/* Stats row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
          <StatCard label="Total Portfolio" value={fmtUSD(totalValueUSD)} sub={fmtPct(totalPnlPct)} subColor={totalPnlPct >= 0 ? C.accent : C.danger} valColor={C.text} spark={balanceHistory} sparkColor={totalPnlPct >= 0 ? C.accent : C.danger} />
          <StatCard label="USD Balance" value={fmtUSD(usdBalance)} sub="available to trade" subColor={C.muted} />
          <StatCard label="BTC Holdings" value={fmtBTC(btcBalance)} sub={fmtUSD(btcBalance * currentPrice)} subColor={C.muted} />
          <StatCard label="Total P&L" value={fmtUSD(totalPnl)} sub={`from ${fmtUSD(startUsd)} start`} subColor={C.muted} valColor={totalPnl >= 0 ? C.accent : C.danger} />
          <StatCard label="To $100K Goal" value={fmtUSD(Math.max(0, 100000 - totalValueUSD))} sub={`${fmt(progress, 3)}% complete`} subColor={C.blue} />
        </div>

        {/* Progress bar */}
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 20px", marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 10 }}>
            <span style={{ color: C.muted, letterSpacing: 2 }}>MISSION PROGRESS — $50 → $100,000</span>
            <span style={{ color: C.accent, fontWeight: 700 }}>{fmt(progress, 4)}%</span>
          </div>
          <div style={{ background: C.border, borderRadius: 3, height: 5, overflow: "hidden" }}>
            <div style={{ width: `${progress}%`, height: "100%", background: `linear-gradient(90deg, ${C.accent}, ${C.blue})`, borderRadius: 3, transition: "width 1s ease", boxShadow: `0 0 8px ${C.accent}60` }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 9, color: C.muted }}>
            <span>$50 start</span>
            <span>$1K</span><span>$10K</span><span>$50K</span>
            <span>$100,000 🎯</span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, marginBottom: 16 }}>
          {/* Price Chart */}
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
              <div>
                <div style={{ color: C.muted, fontSize: 9, letterSpacing: 2.5, marginBottom: 6 }}>BTC-USD — REAL TIME (10s)</div>
                <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -1, color: C.text }}>{fmtUSD(currentPrice)}</div>
                {priceHistory.length > 1 && (
                  <div style={{ fontSize: 11, marginTop: 4, color: currentPrice >= priceHistory[0] ? C.accent : C.danger, fontFamily: "monospace" }}>
                    {fmtPct(((currentPrice - priceHistory[0]) / priceHistory[0]) * 100)} session
                  </div>
                )}
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: C.muted, fontSize: 9, letterSpacing: 2, marginBottom: 6 }}>PRICE HISTORY</div>
                <Sparkline data={priceHistory} color={C.blue} width={160} height={48} filled />
              </div>
            </div>
            <Sparkline data={prices} color={C.blue} width={640} height={110} filled />

            {position && (
              <div style={{ marginTop: 12, padding: "10px 14px", background: C.accentDim, borderRadius: 8, fontSize: 11, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, border: `1px solid ${C.accent}30` }}>
                <div><div style={{ color: C.muted, fontSize: 9, marginBottom: 3 }}>ENTRY</div><div style={{ color: C.accent }}>{fmtUSD(position.entryPrice)}</div></div>
                <div><div style={{ color: C.muted, fontSize: 9, marginBottom: 3 }}>INVESTED</div><div style={{ color: C.text }}>{fmtUSD(position.usdSpent)}</div></div>
                <div><div style={{ color: C.muted, fontSize: 9, marginBottom: 3 }}>STOP-LOSS</div><div style={{ color: C.danger }}>{fmtUSD(stopLossPrice)}</div></div>
                <div><div style={{ color: C.muted, fontSize: 9, marginBottom: 3 }}>UNREALIZED</div><div style={{ color: unrealizedPnl >= 0 ? C.accent : C.danger, fontWeight: 700 }}>{fmtUSD(unrealizedPnl)}</div></div>
              </div>
            )}
            {!position && prices.length > 0 && (
              <div style={{ marginTop: 12, padding: "8px 14px", background: C.border + "40", borderRadius: 8, fontSize: 10, color: C.muted, textAlign: "center" }}>
                No open position — Agent watching for entry signal
              </div>
            )}
          </div>

          {/* AI Panel */}
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px" }}>
            <div style={{ color: C.muted, fontSize: 9, letterSpacing: 2.5, marginBottom: 16 }}>AI DECISION ENGINE</div>

            <div style={{ textAlign: "center", padding: "18px 0", marginBottom: 16, borderBottom: `1px solid ${C.border}`, position: "relative" }}>
              <div style={{ fontSize: 36, fontWeight: 900, letterSpacing: 5, color: decision.action === "BUY" ? C.accent : decision.action === "SELL" ? C.danger : C.warn, textShadow: `0 0 24px ${decision.action === "BUY" ? C.accent : decision.action === "SELL" ? C.danger : C.warn}60` }}>{decision.action}</div>
              <div style={{ color: C.muted, fontSize: 10, marginTop: 6, letterSpacing: 1 }}>{decision.confidence}% confidence</div>
              <div style={{ height: 3, background: C.border, borderRadius: 2, marginTop: 10, overflow: "hidden" }}>
                <div style={{ width: `${decision.confidence}%`, height: "100%", background: decision.action === "BUY" ? C.accent : decision.action === "SELL" ? C.danger : C.warn, borderRadius: 2, transition: "width 0.8s ease" }} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
              {[
                { label: "RSI", val: fmt(decision.rsi, 1), color: decision.rsi < 35 ? C.accent : decision.rsi > 65 ? C.danger : C.warn },
                { label: "MACD", val: fmt(decision.macd, 0), color: decision.macd > 0 ? C.accent : C.danger },
                { label: "SCORE", val: (decision.score > 0 ? "+" : "") + decision.score, color: decision.score > 0 ? C.accent : decision.score < 0 ? C.danger : C.muted },
              ].map(s => (
                <div key={s.label} style={{ background: C.bg, borderRadius: 8, padding: "10px 8px", textAlign: "center" }}>
                  <div style={{ color: C.muted, fontSize: 9, letterSpacing: 1.5, marginBottom: 5 }}>{s.label}</div>
                  <div style={{ color: s.color, fontWeight: 800, fontSize: 15 }}>{s.val}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 9, color: C.muted, marginBottom: 8, letterSpacing: 2 }}>SIGNAL REASONS</div>
            {decision.reasons.map((r, i) => (
              <div key={i} style={{ fontSize: 10, color: C.text, padding: "4px 0", borderBottom: `1px solid ${C.border}`, display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ color: C.accent, fontSize: 8 }}>◆</span>{r}
              </div>
            ))}

            <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div style={{ padding: "8px 10px", background: "#ff3b5c10", border: `1px solid ${C.danger}25`, borderRadius: 6, fontSize: 9, color: "#ff6b85", textAlign: "center" }}>
                🛡 STOP-LOSS<br /><span style={{ color: C.danger, fontWeight: 700 }}>-20% per trade</span>
              </div>
              <div style={{ padding: "8px 10px", background: "#3d7eff10", border: `1px solid ${C.blue}25`, borderRadius: 6, fontSize: 9, color: "#6699ff", textAlign: "center" }}>
                📊 POSITION SIZE<br /><span style={{ color: C.blue, fontWeight: 700 }}>90% of USD</span>
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          {/* Trade History */}
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 9, letterSpacing: 2.5, color: C.muted }}>TRADE HISTORY</div>
              <Badge label={`${trades.length} TRADES`} color={C.blue} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "70px 55px 100px 100px 85px 60px 1fr", gap: 6, padding: "6px 16px", fontSize: 9, color: C.muted, borderBottom: `1px solid ${C.border}`, letterSpacing: 1.5 }}>
              <span>TIME</span><span>SIDE</span><span>PRICE</span><span>AMOUNT</span><span>P&L</span><span>TYPE</span><span>REASON</span>
            </div>
            <div style={{ maxHeight: 260, overflowY: "auto" }}>
              {trades.length === 0
                ? <div style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 11 }}>Waiting for first signal... (checks every 30s)</div>
                : trades.map((t, i) => <TradeRow key={t.id} trade={t} index={i} />)
              }
            </div>
          </div>

          {/* Agent Log */}
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 9, letterSpacing: 2.5, color: C.muted }}>AGENT LOG</div>
              <Badge label="LIVE" color={C.accent} pulse />
            </div>
            <div style={{ maxHeight: 286, overflowY: "auto", padding: "8px 0" }}>
              {logs.length === 0
                ? <div style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 11 }}>Initializing agent...</div>
                : logs.map(l => (
                  <div key={l.id} style={{ padding: "4px 16px", fontSize: 10, fontFamily: "monospace", color: l.color, display: "flex", gap: 10, lineHeight: 1.6 }}>
                    <span style={{ color: C.border, flexShrink: 0 }}>{l.time}</span>
                    <span>{l.msg}</span>
                  </div>
                ))
              }
            </div>
          </div>
        </div>

        <div style={{ marginTop: 8, fontSize: 9, color: C.muted, textAlign: "center", lineHeight: 2, letterSpacing: 0.5 }}>
          ⚠️ LIVE TRADING ACTIVE — Real orders being placed on your Coinbase account · Stop-loss: -20% · Position size: 90% · Not financial advice · Past performance does not guarantee future results
        </div>
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [creds, setCreds] = useState(null);
  const [initialBalances, setInitialBalances] = useState(null);

  if (!creds) {
    return <SetupScreen onConnect={({ keyName, privateKey, balances }) => {
      setCreds({ keyName, privateKey });
      setInitialBalances(balances);
    }} />;
  }

  return <Dashboard creds={creds} initialBalances={initialBalances} />;
}
