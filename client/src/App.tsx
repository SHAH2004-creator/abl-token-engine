import React, { useCallback, useEffect, useRef, useState } from 'react';
import ablLogo from './logo';

const API_BASE: string = (import.meta as any).env?.VITE_API_BASE ?? 'http://127.0.0.1:8000';
const FEE_RATE = 0.005;
const BENEFICIARY = 'PKR_HOSPITAL_001';

// ---------- types ----------
type Tone = 'ok' | 'bad' | 'wait' | 'na' | 'blue';
type StageState = '' | 'on' | 'done' | 'fail';
type AuditStatus = 'IDLE' | 'INSPECTING' | 'PASSED' | 'REJECTED';
type GLKey = 'casa' | 'escrow' | 'biller' | 'fee';

interface PurposeToken { token_identifier: string; payer_id: string; amount: number; purpose_code: string; state: 'LOCKED' | 'SETTLED'; }
interface Line { ref: string; time: string; journal: string; key: GLKey; acct: string; narr: string; dr: number; cr: number; }
interface AuditProof { attestation: any; signature: string; message?: string; agent_audit_logs?: any[]; }
interface LogRow { text: string; pass: boolean; }
interface AuditState { status: AuditStatus; reason: string | null; proof: AuditProof | null; logs: LogRow[]; }
interface AuditFields { name: string; ntn: string; cat: string; amount: number; }
interface ToastMsg { id: number; msg: string; type: 'ok' | 'error' | 'warn' | ''; }
interface ResultCard { kind: 'ok' | 'bad'; title: string; rows: [string, string][]; }

class ApiError extends Error {
  status: number; data: any;
  constructor(message: string, status: number, data: any) { super(message); this.status = status; this.data = data; }
}

// ---------- helpers ----------
const fmt = (n: number) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const pkt = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(11, 19);
const fmtDetail = (d: any): string =>
  Array.isArray(d) ? d.map(x => `${(x.loc || []).slice(1).join('.')}: ${x.msg}`).join('; ')
  : typeof d === 'string' ? d : d?.reason ?? (d ? JSON.stringify(d) : '');
const toLog = (x: any): LogRow => {
  const text = typeof x === 'string' ? x : x?.message ?? JSON.stringify(x);
  return { text, pass: !/FAIL|REJECT|MISMATCH|INVALID|EXCEED|BREACH|DENIED|NOT ACTIVE|NOT FOUND/i.test(text) };
};

const PRESET_OK: AuditFields = { name: 'Shaukat Khanum Memorial Hospital', ntn: '1234567-8', cat: 'MEDICAL_ALLOWANCE', amount: 15000 };
const PRESET_BAD: AuditFields = { name: 'Lahore Commercial Electronics', ntn: '9876543-1', cat: 'ELECTRONICS_PURCHASE', amount: 15000 };
const IDLE_AUDIT: AuditState = { status: 'IDLE', reason: null, proof: null, logs: [] };

const GL_ROWS: { key: GLKey; account: string; code: string; type: string; bar: string; tone: string; badge: [Tone, string] }[] = [
  { key: 'casa', account: 'Originator CASA · PKR_USER_001', code: 'GL-1010', type: 'Liability · demand deposit', bar: '#0A3B85', tone: 'text-navy', badge: ['ok', 'ACTIVE'] },
  { key: 'escrow', account: 'ABL transit escrow · ABL_ESCROW_GL', code: 'GL-2050', type: 'Liability · bank float', bar: '#F37021', tone: 'text-orange', badge: ['blue', 'ZERO LEAKAGE'] },
  { key: 'biller', account: 'Approved biller · PKR_HOSPITAL_001', code: 'GL-3010', type: 'Liability · settled credit', bar: '#059669', tone: 'text-ok', badge: ['ok', 'ACTIVE'] },
  { key: 'fee', account: 'ABL fee income (0.50%, non-markup)', code: 'GL-4001', type: 'Income · 50 bps fee', bar: '#1E63D6', tone: 'text-azure', badge: ['ok', 'ACTIVE'] },
];

const STAGES = [
  ['Encumbrance', 'CASA debit and token lock'],
  ['Transit', 'Held in escrow GL'],
  ['Attestation', 'Oracle invoice and tax audit'],
  ['Settlement', 'Biller credit and fee capture'],
];

// ---------- small components ----------
const Tag = ({ tone, children, className = '' }: { tone: Tone; children: React.ReactNode; className?: string }) =>
  <span className={`tag t-${tone} ${className}`}>{children}</span>;

const Svg = ({ children }: { children: React.ReactNode }) =>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>{children}</svg>;

const Field = ({ label, children }: { label: string; children: React.ReactNode }) =>
  <div><label className="lbl block mb-1.5">{label}</label>{children}</div>;

function CountCell({ value, className = '' }: { value: number; className?: string }) {
  const [v, setV] = useState(value);
  const [dir, setDir] = useState('');
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current; prev.current = value;
    if (from === value) return;
    setDir(value > from ? 'flash-up' : 'flash-down');
    const t0 = performance.now(); let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 700), e = 1 - Math.pow(1 - p, 3);
      setV(from + (value - from) * e);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const to = setTimeout(() => setDir(''), 1400);
    return () => { cancelAnimationFrame(raf); clearTimeout(to); };
  }, [value]);
  return <td className={`num ${className} ${dir}`}>{fmt(v)}</td>;
}

// ---------- app ----------
export default function App() {
  const [accounts, setAccounts] = useState<Record<string, number>>({});
  const [token, setToken] = useState<PurposeToken | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [stages, setStages] = useState<StageState[]>(['', '', '', '']);
  const [audit, setAudit] = useState<AuditState>(IDLE_AUDIT);
  const [stream, setStream] = useState<string[]>([]);
  const [busy, setBusy] = useState<'' | 'lock' | 'audit' | 'settle'>('');
  const [demo, setDemo] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [result, setResult] = useState<ResultCard | null>(null);
  const [shake, setShake] = useState(false);
  const [now, setNow] = useState(new Date());
  const [tab, setTab] = useState(0);

  // issuance form
  const [payer, setPayer] = useState('PKR_USER_001');
  const [purpose, setPurpose] = useState('MEDICAL_ALLOWANCE');
  const [tenor, setTenor] = useState('T+3 · 72h');
  const [lockAmount, setLockAmount] = useState(15000);
  // oracle form
  const [merchantName, setMerchantName] = useState(PRESET_OK.name);
  const [merchantNtn, setMerchantNtn] = useState(PRESET_OK.ntn);
  const [invoiceCategory, setInvoiceCategory] = useState(PRESET_OK.cat);
  const [claimAmount, setClaimAmount] = useState(15000);

  const refN = useRef(0);
  const demoRef = useRef(false);
  const streamEnd = useRef<HTMLPreElement>(null);
  const nextRef = useRef<() => void>(() => {});

  // ----- ui utilities -----
  const toast = (msg: string, type: ToastMsg['type'] = '') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), type === 'error' ? 6500 : 3800);
  };
  const log = (m: string) => setStream(s => [...s, `[${pkt()}] ${m}`]);
  const setStage = (n: number, st: StageState) => setStages(s => s.map((x, i) => (i === n - 1 ? st : x)));
  const post = (journal: string, key: GLKey, acct: string, narr: string, dr: number, cr: number) =>
    setLines(l => [...l, { ref: `ABL-PBM-${String(++refN.current).padStart(6, '0')}`, time: pkt(), journal, key, acct, narr, dr, cr }]);

  // ----- api -----
  const call = async (method: string, path: string, body?: unknown) => {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(API_BASE + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      setOnline(false); setLatency(null);
      throw new ApiError(`Backend unreachable at ${API_BASE}. Is uvicorn running?`, 0, null);
    }
    setOnline(true); setLatency(Math.round(performance.now() - t0));
    const raw = await res.text();
    let data: any = null;
    try { data = JSON.parse(raw); } catch { /* non-JSON body */ }
    if (!res.ok) throw new ApiError(fmtDetail(data?.detail ?? data?.message) || `HTTP ${res.status} ${method} ${path}`, res.status, data);
    return data;
  };

  const fetchBalances = useCallback(async (manual = false) => {
    try {
      const data: { account: string; balance: number }[] = await call('GET', '/api/accounts/overview');
      const map: Record<string, number> = {};
      data.forEach(a => { map[a.account] = a.balance; });
      setAccounts(map);
      if (manual) toast('Balances synchronised with CBS.', 'ok');
    } catch (e) { if (manual) toast((e as Error).message, 'error'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- core steps (explicit args so the guided demo can chain them) -----
  const doLock = async (amount: number, purp: string): Promise<PurposeToken | null> => {
    if (!(amount > 0)) { toast('Enter a lock amount greater than zero.', 'warn'); return null; }
    if (accounts[payer] !== undefined && amount > accounts[payer] + 0.001) { toast('Lock amount exceeds unencumbered CASA liquidity.', 'warn'); return null; }
    setBusy('lock'); setStages(['on', '', '', '']); setAudit(IDLE_AUDIT);
    log(`LOCK_REQUEST payer=${payer} purpose=${purp} amount=${fmt(amount)} tenor="${tenor}"`);
    try {
      const t: PurposeToken = await call('POST', '/api/tokens/lock', {
        payer_account_number: payer, amount, purpose_code: purp, beneficiary_account_number: BENEFICIARY,
      });
      setToken(t); setClaimAmount(t.amount);
      post('JNL-LOCK', 'casa', `Originator CASA · ${payer}`, `Debit: funds encumbered under ${t.purpose_code}`, t.amount, 0);
      post('JNL-LOCK', 'escrow', 'ABL transit escrow · ABL_ESCROW_GL', `Credit: purpose-bound token ${t.token_identifier}`, 0, t.amount);
      setStages(['done', 'on', '', '']);
      log(`LOCK_CONFIRMED token=${t.token_identifier} state=${t.state}`);
      toast(`Token issued · PKR ${fmt(t.amount)} encumbered`, 'ok');
      fetchBalances();
      return t;
    } catch (err) {
      setStage(1, 'fail'); log('LOCK_FAILED: ' + (err as Error).message); toast('Lock failed: ' + (err as Error).message, 'error');
      return null;
    } finally { setBusy(''); }
  };

  const doAudit = async (t: PurposeToken, f: AuditFields): Promise<AuditProof | null> => {
    setBusy('audit'); setStage(3, 'on'); setAudit(a => ({ ...a, status: 'INSPECTING', reason: null }));
    log(`ORACLE_REQUEST ${JSON.stringify({ token: t.token_identifier, merchant: f.name, ntn: f.ntn, category: f.cat, amount: f.amount })}`);
    try {
      const data: AuditProof = await call('POST', '/api/oracle/audit-invoice', {
        token_identifier: t.token_identifier, merchant_name: f.name, merchant_ntn: f.ntn,
        category: f.cat, amount: f.amount, beneficiary_account_number: BENEFICIARY,
      });
      setAudit({ status: 'PASSED', reason: null, proof: data, logs: (data.agent_audit_logs || []).map(toLog) });
      setStage(3, 'done');
      log('ORACLE_RESPONSE ' + JSON.stringify(data, null, 2)); log('ATTESTATION_ISSUED · release path unlocked');
      toast('Oracle attestation issued.', 'ok');
      return data;
    } catch (err) {
      const e = err as ApiError;
      const d = e.data?.detail;
      if (e.status === 422 && d && typeof d === 'object' && !Array.isArray(d)) {
        const reason = d.reason || 'Policy invariant violation';
        const rl: LogRow[] = (d.logs || []).map(toLog);
        if (rl.length && rl.every(r => r.pass)) rl[rl.length - 1].pass = false;
        setAudit({ status: 'REJECTED', reason, proof: null, logs: rl });
        setStage(3, 'fail'); setShake(true); setTimeout(() => setShake(false), 600);
        log('ORACLE_RESPONSE ' + JSON.stringify(e.data, null, 2)); log('ATTESTATION_DENIED · funds remain encumbered in escrow');
        toast('Oracle rejected the claim. Funds stay in escrow.', 'error');
        setResult({ kind: 'bad', title: 'Claim blocked by oracle', rows: [['Merchant', f.name], ['Category', f.cat], ['Reason', reason], ['Funds', 'Remain encumbered in escrow']] });
      } else {
        setAudit(a => ({ ...a, status: 'IDLE' })); setStage(3, 'fail');
        log('ORACLE_ERROR: ' + e.message); toast('Audit error: ' + e.message, 'error');
      }
      return null;
    } finally { setBusy(''); }
  };

  const doSettle = async (t: PurposeToken, proof: AuditProof): Promise<boolean> => {
    setBusy('settle'); log('SETTLE_REQUEST token=' + t.token_identifier);
    try {
      const d = await call('POST', '/api/tokens/settle', {
        token_identifier: t.token_identifier, beneficiary_account_number: BENEFICIARY,
        attestation: proof.attestation, signature: proof.signature,
      });
      const net: number = d.settled_amount, fee: number = d.bank_fee_captured, gross = net + fee;
      post('JNL-SETTLE', 'escrow', 'ABL transit escrow · ABL_ESCROW_GL', 'Debit: token released on attestation', gross, 0);
      post('JNL-SETTLE', 'biller', `Approved biller · ${BENEFICIARY}`, `Credit: net proceeds to ${merchantName}`, 0, net);
      post('JNL-FEE', 'fee', 'ABL fee income · GL-4001', 'Credit: 0.50% non-markup fee', 0, fee);
      setToken(p => (p ? { ...p, state: 'SETTLED' } : p)); setStages(['done', 'done', 'done', 'done']);
      log('SETTLE_CONFIRMED ' + JSON.stringify(d));
      toast(`Settled · PKR ${fmt(net)} to biller, PKR ${fmt(fee)} fee captured`, 'ok');
      setResult({ kind: 'ok', title: 'Settlement complete', rows: [['Token', t.token_identifier], ['Net to biller', `PKR ${fmt(net)}`], ['Fee captured (0.50%)', `PKR ${fmt(fee)}`], ['Escrow residual', 'PKR 0.00']] });
      fetchBalances();
      return true;
    } catch (err) {
      setStage(4, 'fail'); log('SETTLE_FAILED: ' + (err as Error).message); toast('Settlement failed: ' + (err as Error).message, 'error');
      return false;
    } finally { setBusy(''); }
  };

  const applyPreset = (p: AuditFields, amount?: number) => {
    setMerchantName(p.name); setMerchantNtn(p.ntn); setInvoiceCategory(p.cat);
    setClaimAmount(amount ?? token?.amount ?? p.amount);
    setAudit(IDLE_AUDIT);
  };

  const runDemo = async (kind: 'ok' | 'bad') => {
    if (demoRef.current) return;
    demoRef.current = true; setDemo(true);
    try {
      setPurpose('MEDICAL_ALLOWANCE'); setLockAmount(15000);
      const t = await doLock(15000, 'MEDICAL_ALLOWANCE'); if (!t) return;
      await wait(600);
      const p = kind === 'ok' ? PRESET_OK : PRESET_BAD;
      applyPreset(p, t.amount); await wait(500);
      const proof = await doAudit(t, { ...p, amount: t.amount });
      if (proof) { await wait(600); await doSettle(t, proof); }
    } finally { demoRef.current = false; setDemo(false); }
  };

  const clearView = () => {
    setLines([]); setToken(null); setAudit(IDLE_AUDIT); setStages(['', '', '', '']); setStream([]); refN.current = 0;
    fetchBalances(); toast('Session view cleared. Balances re-synced from CBS.');
  };

  const exportCSV = () => {
    if (!lines.length) return toast('No journal entries to export yet.', 'warn');
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['Ref', 'Time_PKT', 'Journal', 'GL_Account', 'Narrative', 'Debit_PKR', 'Credit_PKR'],
      ...lines.map(l => [l.ref, l.time, l.journal, l.acct, l.narr, l.dr.toFixed(2), l.cr.toFixed(2)])];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' }));
    a.download = 'abl_pbm_journal.csv'; a.click(); toast('Journal exported.', 'ok');
  };

  const copySig = () => {
    const s = audit.proof?.signature;
    if (!s) return toast('No signature yet.', 'warn');
    navigator.clipboard?.writeText(s).then(() => toast('Signature copied.', 'ok'));
  };

  // ----- effects -----
  nextRef.current = () => {
    if (demo || busy) return;
    if (!token || token.state === 'SETTLED') doLock(lockAmount, purpose);
    else if (audit.status !== 'PASSED') doAudit(token, { name: merchantName, ntn: merchantNtn, cat: invoiceCategory, amount: claimAmount });
    else if (audit.proof) doSettle(token, audit.proof);
  };

  useEffect(() => {
    fetchBalances();
    const clock = setInterval(() => setNow(new Date()), 1000);
    const poll = setInterval(() => { if (!demoRef.current) fetchBalances(); }, 15000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setResult(null);
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); nextRef.current(); }
    };
    const onClick = (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest('.btn') as HTMLButtonElement | null;
      if (!b || b.disabled) return;
      const r = b.getBoundingClientRect(), s = document.createElement('span');
      s.className = 'rip'; s.style.left = e.clientX - r.left + 'px'; s.style.top = e.clientY - r.top + 'px';
      b.appendChild(s); setTimeout(() => s.remove(), 650);
    };
    window.addEventListener('keydown', onKey); document.addEventListener('click', onClick);
    const ids = ['sec-gl', 'sec-issue', 'sec-oracle', 'sec-journal'];
    const io = new IntersectionObserver(es => es.forEach(x => { if (x.isIntersecting) setTab(ids.indexOf(x.target.id)); }), { rootMargin: '-35% 0px -55% 0px' });
    ids.forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => { clearInterval(clock); clearInterval(poll); window.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick); io.disconnect(); };
  }, [fetchBalances]);

  useEffect(() => { if (streamEnd.current) streamEnd.current.scrollTop = streamEnd.current.scrollHeight; }, [stream]);
  useEffect(() => { if (!result) return; const t = setTimeout(() => setResult(null), 7000); return () => clearTimeout(t); }, [result]);

  // ----- derived -----
  const sums = (k: GLKey) => lines.filter(l => l.key === k).reduce((a, l) => ({ d: a.d + l.dr, c: a.c + l.cr }), { d: 0, c: 0 });
  const net: Record<GLKey, number> = {
    casa: accounts['PKR_USER_001'] ?? 0, escrow: accounts['ABL_ESCROW_GL'] ?? 0,
    biller: accounts['PKR_HOSPITAL_001'] ?? 0, fee: accounts['ABL_FEE_GL'] ?? sums('fee').c,
  };
  const totDr = lines.reduce((a, l) => a + l.dr, 0), totCr = lines.reduce((a, l) => a + l.cr, 0);
  const balanced = Math.abs(totDr - totCr) < 0.005;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const pk = new Date(now.getTime() + 5 * 3600e3);
  const utcStr = `${now.getUTCFullYear()}-${p2(now.getUTCMonth() + 1)}-${p2(now.getUTCDate())} ${p2(now.getUTCHours())}:${p2(now.getUTCMinutes())}:${p2(now.getUTCSeconds())}`;
  const pktStr = `${p2(pk.getUTCHours())}:${p2(pk.getUTCMinutes())}:${p2(pk.getUTCSeconds())}`;
  const valueDate = `${pk.getUTCFullYear()}-${p2(pk.getUTCMonth() + 1)}-${p2(pk.getUTCDate())}`;
  const feePreview = Math.round(lockAmount * FEE_RATE * 100) / 100;
  const overLiquidity = accounts[payer] !== undefined && lockAmount > accounts[payer] + 0.001;
  const progress = Math.min(100, stages.filter(s => s === 'done').length * 25 + stages.filter(s => s === 'on').length * 10);
  const anyFail = stages.includes('fail');
  const mc: [Tone, string] = audit.status === 'PASSED' ? ['ok', 'C: AUTHORISED'] : audit.status === 'REJECTED' ? ['bad', 'C: REJECTED'] : ['wait', 'C: PENDING'];
  const verdictTone: Tone = audit.status === 'PASSED' ? 'ok' : audit.status === 'REJECTED' ? 'bad' : audit.status === 'INSPECTING' ? 'wait' : 'na';
  const canAudit = !!token && token.state === 'LOCKED' && !busy && !demo;
  const canSettle = audit.status === 'PASSED' && token?.state === 'LOCKED' && !busy && !demo;
  const derivedLogs: LogRow[] = audit.status === 'IDLE' || audit.status === 'INSPECTING' ? [] : [
    { text: 'Purpose code matches token policy', pass: invoiceCategory === token?.purpose_code },
    { text: 'Claim within encumbered amount', pass: claimAmount <= (token?.amount ?? 0) },
    { text: 'Merchant NTN active in FBR registry', pass: audit.status === 'PASSED' },
  ];
  const shownLogs = audit.logs.length ? audit.logs : derivedLogs;

  // ----- render -----
  return (
    <div className="min-h-screen bg-white text-[#27324A] font-sans">
      {/* toasts */}
      <div className="fixed top-3.5 right-3.5 z-50 flex flex-col gap-2 w-[min(380px,calc(100vw-28px))]" aria-live="polite">
        {toasts.map(t => <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>)}
      </div>

      {/* result modal */}
      {result && (
        <div className="ov" onClick={() => setResult(null)} role="dialog" aria-modal="true">
          <div className={`ov-card ${result.kind === 'bad' ? 'bad' : ''}`} onClick={e => e.stopPropagation()}>
            <svg className={`ck ${result.kind}`} viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="26" />
              <path d={result.kind === 'ok' ? 'M20 33l8 8 16-17' : 'M22 22l20 20M42 22L22 42'} />
            </svg>
            <h3>{result.title}</h3>
            <dl>{result.rows.map(([a, b]) => <React.Fragment key={a}><dt>{a}</dt><dd>{b}</dd></React.Fragment>)}</dl>
            <button className="btn btn-b !px-8" onClick={() => setResult(null)}>Continue</button>
          </div>
        </div>
      )}

      {/* utility strip */}
      <div className="bg-paper border-b border-rule">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-2 text-[12.5px] text-steel">
          <span>UTC <span className="font-mono text-ink">{utcStr}</span></span>
          <span>PKT <span className="font-mono text-ink">{pktStr}</span></span>
          <span>Value date <span className="font-mono text-ink">{valueDate}</span></span>
          <span className="flex items-center gap-2">Maker–Checker <span className="text-ink">M: ops.maker01</span><Tag tone={mc[0]}>{mc[1]}</Tag></span>
          <span className="flex items-center gap-2">CBS core sync
            <span className={`w-2.5 h-2.5 inline-block ${online ? 'bg-ok dot-ok' : online === false ? 'bg-breach' : 'bg-steel'}`} />
            <span className="font-mono text-ink">{online === false ? 'offline' : latency !== null ? `${latency} ms` : '-- ms'}</span>
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Tag tone="ok">SBP CLEARANCE: ACTIVE</Tag><Tag tone="blue">PBM FACILITY</Tag><Tag tone="na">DEMO ENVIRONMENT</Tag>
          </span>
        </div>
      </div>

      {online === false && (
        <div className="bg-[#FDECEA] border-b border-[#F5B1AC] text-[#991B1B] px-5 py-2 text-[13px] flex flex-wrap items-center gap-3">
          <b>Backend offline.</b>
          <span>No response from <code className="font-mono">{API_BASE}</code>. Start it with <code className="font-mono bg-white px-1 border border-[#F5B1AC]">uvicorn main:app --reload --port 8000</code>.</span>
          <button className="btn !py-1 !text-[12px] ml-auto" onClick={() => fetchBalances(true)}>Retry connection</button>
        </div>
      )}

      {/* brand header */}
      <header className="border-b-[3px] border-orange bg-white">
        <div className="flex flex-wrap items-center gap-x-10 gap-y-2 px-5 py-2">
          <img src={ablLogo} alt="Allied Bank" className="h-14 w-auto" />
          <div className="pl-8 border-l border-rule">
            <div className="text-[17px] font-medium text-navy leading-tight">PBM Settlement Core</div>
            <div className="text-[12.5px] text-steel leading-tight">Treasury Operations Console · Programmable deposit settlement</div>
          </div>
          <nav className="flex gap-7 ml-4">
            {[['sec-gl', 'General ledger'], ['sec-issue', 'Token issuance'], ['sec-oracle', 'Oracle audit'], ['sec-journal', 'Journal']].map(([id, label], i) =>
              <a key={id} href={`#${id}`} className={`tab ${tab === i ? 'act' : ''}`}>{label}</a>)}
          </nav>
          <button className="btn btn-o ml-auto" onClick={() => fetchBalances(true)}>Sync CBS</button>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 border-t border-rule divide-x divide-rule">
          {STAGES.map(([l, t], i) => (
            <div key={l} className={`stage ${stages[i]}`}>
              <i className="sn">{stages[i] === 'done' ? '✓' : stages[i] === 'fail' ? '✕' : i + 1}</i>
              <div><span className="lbl">{l}</span><b>{t}</b></div>
            </div>
          ))}
        </div>
        <div className="bg-rule"><div className={`prog ${anyFail ? 'bad' : ''}`} style={{ width: progress + '%' }} /></div>
      </header>

      <main className="p-5 space-y-5 max-w-[1700px] mx-auto">
        {/* guided demo toolbar */}
        <div className="flex flex-wrap items-center gap-2 border border-rule bg-paper px-4 py-2.5">
          <span className="lbl mr-2">Guided demo</span>
          <button className="btn btn-g" disabled={demo || !!busy} onClick={() => runDemo('ok')}>▶ Run valid claim end-to-end</button>
          <button className="btn btn-r" disabled={demo || !!busy} onClick={() => runDemo('bad')}>▶ Run fraud attempt</button>
          <span className="ml-auto flex items-center gap-2">
            <button className="btn" onClick={exportCSV}>Export journal CSV</button>
            <button className="btn" onClick={clearView}>Clear session view</button>
            <span className="text-[12px] text-steel hidden md:inline"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> next step</span>
          </span>
        </div>

        {/* GL matrix */}
        <section className="pane" id="sec-gl">
          <div className="pane-h">
            <div>
              <h2><span className="ico"><Svg><path d="M4 5h16M4 12h16M4 19h16" /></Svg></span>General ledger balance matrix</h2>
              <div className="sub">Net balances from CBS · debit and credit columns show this session's postings</div>
            </div>
            <Tag tone={balanced ? 'ok' : 'bad'}>{balanced ? 'BALANCED · Σ DR = Σ CR' : 'OUT OF BALANCE'}</Tag>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>GL account</th><th>Ledger code</th><th>Type</th><th className="r">Debit (PKR)</th><th className="r">Credit (PKR)</th><th className="r">Net balance (PKR)</th><th>Status</th></tr></thead>
              <tbody>
                {GL_ROWS.map(g => {
                  const s = sums(g.key);
                  return (
                    <tr key={g.key} className="gl" style={{ ['--bar' as any]: g.bar }}>
                      <td className="font-medium text-ink">{g.account}</td>
                      <td className="font-mono text-[13px] text-steel">{g.code}</td>
                      <td className="text-steel">{g.type}</td>
                      <td className="num">{fmt(s.d)}</td><td className="num">{fmt(s.c)}</td>
                      <CountCell value={net[g.key]} className={`${g.tone} font-bold text-[15px]`} />
                      <td><Tag tone={g.badge[0]}>{g.badge[1]}</Tag></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
          {/* issuance */}
          <section className="pane xl:col-span-5" id="sec-issue">
            <div className="pane-h">
              <div>
                <h2><span className="ico"><Svg><rect x="5" y="11" width="14" height="9" /><path d="M8 11V8a4 4 0 018 0v3" /></Svg></span>Token issuance</h2>
                <div className="sub">Encumber funds under a purpose-bound condition</div>
              </div>
              <Tag tone="blue">CASA → ESCROW</Tag>
            </div>
            <div className="p-4 space-y-4">
              <Field label="Payer account (demand deposit)">
                <div className="flex gap-2">
                  <input className="fld m" value={payer} onChange={e => setPayer(e.target.value)} />
                  <Tag tone="ok" className="self-center">CASA ACTIVE</Tag>
                </div>
              </Field>
              <Field label="Purpose-bound code">
                <select className="fld" value={purpose} onChange={e => setPurpose(e.target.value)}>
                  <option value="MEDICAL_ALLOWANCE">MEDICAL_ALLOWANCE · designated healthcare only</option>
                  <option value="TUITION_FEE">TUITION_FEE · HEC accredited universities</option>
                  <option value="VENDOR_ESCROW">VENDOR_ESCROW · B2B procurement supply chain</option>
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="lbl block mb-1.5">Lock amount (PKR)</label>
                  <input type="number" min={0} step="0.01" className={`fld m text-right ${overLiquidity ? 'err' : ''}`} value={lockAmount} onChange={e => setLockAmount(Number(e.target.value))} />
                  <div className="text-[12px] text-breach mt-1 min-h-[18px]">{overLiquidity ? `Exceeds unencumbered liquidity (PKR ${fmt(accounts[payer])})` : ''}</div>
                </div>
                <Field label="Lock tenor">
                  <select className="fld" value={tenor} onChange={e => setTenor(e.target.value)}>
                    <option>T+1 · 24h</option><option>T+3 · 72h</option><option>T+7 · 7d</option>
                  </select>
                </Field>
              </div>
              <div className="flex gap-2 flex-wrap -mt-2">
                {[[5000, '5,000.00'], [15000, '15,000.00 (standard)'], [35000, '35,000.00']].map(([v, l]) =>
                  <button key={v} type="button" className="btn" onClick={() => setLockAmount(v as number)}>{l}</button>)}
              </div>
              <div className="grid grid-cols-3 border border-rule divide-x divide-rule text-center">
                <div className="p-2"><div className="lbl">Encumbered</div><div className="num !text-center text-navy font-medium">{fmt(lockAmount)}</div></div>
                <div className="p-2"><div className="lbl">Fee at settlement</div><div className="num !text-center text-azure font-medium">{fmt(feePreview)}</div></div>
                <div className="p-2 bg-[#F3FBF7]"><div className="lbl">Net to biller</div><div className="num !text-center text-ok font-bold">{fmt(lockAmount - feePreview)}</div></div>
              </div>
              <div className="border-l-[3px] border-orange bg-paper p-3 text-[13px] text-steel">
                Funds are debited 1:1 from the originator CASA and held against the purpose-bound code. Release requires a signed oracle attestation; there is no release path for a non-conforming merchant.
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 border-t border-rule pt-3">
                <dt className="text-steel">Token ID</dt><dd className="num text-ink">{token?.token_identifier ?? 'not issued'}</dd>
                <dt className="text-steel">Token state</dt><dd className="text-right"><Tag tone={token ? (token.state === 'LOCKED' ? 'wait' : 'ok') : 'na'}>{token?.state ?? 'NONE'}</Tag></dd>
                <dt className="text-steel">Encumbered</dt><dd className="num text-ink">PKR {fmt(token?.amount ?? 0)}</dd>
              </dl>
              <button className={`btn btn-o w-full !py-3 ${busy === 'lock' ? 'loading' : ''}`} disabled={!!busy || demo} onClick={() => doLock(lockAmount, purpose)}>
                Authorise and encumber funds
              </button>
            </div>
          </section>

          {/* oracle */}
          <section className={`pane xl:col-span-7 ${shake ? 'shake-it' : ''}`} id="sec-oracle">
            <div className="pane-h">
              <div>
                <h2><span className="ico"><Svg><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></Svg></span>Agentic AI verification oracle</h2>
                <div className="sub">Invoice verification, FBR registry check and HMAC attestation</div>
              </div>
              <Tag tone="blue">HMAC-SHA256</Tag>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2 border border-rule bg-paper px-3 py-2">
                <span className="lbl mr-auto">Audit presets</span>
                <button className="btn btn-g" onClick={() => applyPreset(PRESET_OK)}>Valid hospital claim</button>
                <button className="btn btn-r" onClick={() => applyPreset(PRESET_BAD)}>Retail electronics (breach)</button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Claimant merchant name"><input className="fld" value={merchantName} onChange={e => setMerchantName(e.target.value)} /></Field>
                <Field label="Merchant NTN (FBR)"><input className="fld m" value={merchantNtn} onChange={e => setMerchantNtn(e.target.value)} /></Field>
                <Field label="Invoice category code">
                  <select className="fld" value={invoiceCategory} onChange={e => setInvoiceCategory(e.target.value)}>
                    <option value="MEDICAL_ALLOWANCE">MEDICAL_ALLOWANCE (matches token policy)</option>
                    <option value="TUITION_FEE">TUITION_FEE</option>
                    <option value="VENDOR_ESCROW">VENDOR_ESCROW</option>
                    <option value="ELECTRONICS_PURCHASE">ELECTRONICS_PURCHASE (simulate misappropriation)</option>
                  </select>
                </Field>
                <Field label="Claim invoice amount (PKR)">
                  <input type="number" min={0} step="0.01" className="fld m text-right" value={claimAmount} onChange={e => setClaimAmount(Number(e.target.value))} />
                </Field>
              </div>
              <div className="flex gap-3">
                <button className={`btn btn-b flex-1 !py-3 ${busy === 'audit' ? 'loading' : ''}`} disabled={!canAudit}
                  onClick={() => token && doAudit(token, { name: merchantName, ntn: merchantNtn, cat: invoiceCategory, amount: claimAmount })}>
                  Run oracle audit
                </button>
                <button className={`btn btn-o flex-1 !py-3 ${busy === 'settle' ? 'loading' : ''}`} disabled={!canSettle}
                  onClick={() => token && audit.proof && doSettle(token, audit.proof)}>
                  Authorise settlement (net of fee)
                </button>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="border border-rule">
                  <div className="px-3 py-2 border-b border-rule bg-paper flex justify-between items-center">
                    <span className="lbl !text-navy">Invariant evaluation</span>
                    <span key={audit.status} className={`tag t-${verdictTone} stamp`}>{audit.status === 'PASSED' ? 'APPROVED' : audit.status}</span>
                  </div>
                  <table className="tbl"><tbody>
                    {shownLogs.length === 0
                      ? <tr><td className="text-steel">{audit.status === 'INSPECTING' ? 'Auditing invariants…' : 'Awaiting audit trigger.'}</td></tr>
                      : shownLogs.map((r, i) => (
                        <tr key={`${audit.status}-${i}`} className="rr" style={{ animationDelay: `${i * 160}ms` }}>
                          <td className="text-ink text-[13px]">{r.text}</td>
                          <td className="text-right"><Tag tone={r.pass ? 'ok' : 'bad'}>{r.pass ? 'PASS' : 'FAIL'}</Tag></td>
                        </tr>))}
                  </tbody></table>
                  {(audit.reason || audit.proof?.message) && (
                    <div className={`px-3 py-2 text-[12.5px] ${audit.reason ? 'text-breach' : 'text-steel'}`}>
                      {audit.reason ? <><b>Breach detected:</b> {audit.reason}</> : audit.proof?.message}
                    </div>
                  )}
                </div>
                <div className="border border-rule">
                  <div className="px-3 py-2 border-b border-rule bg-paper flex justify-between items-center">
                    <span className="lbl !text-navy">Cryptographic proof</span>
                    <Tag tone={audit.proof ? 'ok' : 'na'}>{audit.proof ? 'VERIFIED' : 'N/A'}</Tag>
                  </div>
                  <dl className="p-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                    <dt className="text-steel">Algorithm</dt><dd className="num text-ink">HMAC-SHA256</dd>
                    <dt className="text-steel">Signature</dt><dd className="num break-all !whitespace-normal text-[12px] text-ink">{audit.proof?.signature ?? '—'}</dd>
                    <dt className="text-steel">Approved</dt><dd className="num text-ink">{audit.proof?.attestation?.approved_amount !== undefined ? `PKR ${fmt(Number(audit.proof.attestation.approved_amount))}` : '—'}</dd>
                  </dl>
                  <div className="px-3 pb-3"><button className="btn !py-1 !text-[12px]" onClick={copySig}>Copy signature</button></div>
                </div>
              </div>

              <div className="border border-rule">
                <div className="px-3 py-2 border-b border-rule bg-paper flex justify-between">
                  <span className="lbl !text-navy">Raw payload · audit stream</span>
                  <span className="lbl">{busy === 'audit' ? 'RUNNING' : audit.status === 'PASSED' ? 'ATTESTED' : audit.status === 'REJECTED' ? 'DENIED' : 'IDLE'}</span>
                </div>
                <pre ref={streamEnd} className={`font-mono text-[12px] leading-relaxed p-3 h-44 overflow-auto text-ink whitespace-pre-wrap bg-white ${busy === 'audit' ? 'cursor-run' : ''}`}>
                  {stream.length ? stream.join('\n') : 'Engine standing by. Issue a token to begin.'}
                </pre>
              </div>
            </div>
          </section>
        </div>

        {/* journal */}
        <section className="pane" id="sec-journal">
          <div className="pane-h">
            <div>
              <h2><span className="ico"><Svg><path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3z" /><path d="M9 9h6M9 13h6" /></Svg></span>Transaction ledger</h2>
              <div className="sub">Double-entry journal with sequential reference IDs</div>
            </div>
            <span className="lbl">{lines.length} ENTRIES</span>
          </div>
          <div className="overflow-auto max-h-72">
            <table className="tbl">
              <thead><tr><th>Ref ID</th><th>Time (PKT)</th><th>Journal</th><th>GL account</th><th>Narrative</th><th className="r">Debit (PKR)</th><th className="r">Credit (PKR)</th></tr></thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr><td colSpan={7} className="text-steel py-6 text-center">No postings this session. Encumber funds, or run the guided demo, to open the first journal.</td></tr>
                ) : [...lines].reverse().map(l => (
                  <tr key={l.ref} className="new">
                    <td className="font-mono text-[13px] text-orange font-medium">{l.ref}</td>
                    <td className="font-mono text-[13px] text-steel">{l.time}</td>
                    <td className="font-mono text-[13px] text-navy">{l.journal}</td>
                    <td className="text-ink">{l.acct}</td>
                    <td className="text-steel">{l.narr}</td>
                    <td className={`num ${l.dr ? 'text-ink font-medium' : 'text-slate-300'}`}>{fmt(l.dr)}</td>
                    <td className={`num ${l.cr ? 'text-ink font-medium' : 'text-slate-300'}`}>{fmt(l.cr)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="bg-paper">
                <td colSpan={5} className="lbl text-right">Session totals</td>
                <td className="num text-ink font-bold">{fmt(totDr)}</td><td className="num text-ink font-bold">{fmt(totCr)}</td>
              </tr></tfoot>
            </table>
          </div>
        </section>

        <footer className="text-[12px] text-steel flex flex-wrap justify-between gap-2 px-1 pb-4 border-t border-rule pt-3">
          <span>Allied Bank Limited · Internal use only · Demonstration environment, no production funds</span>
          <span className="font-mono">PBM-CORE v1.0 · SBP-aligned programmable deposit facility</span>
        </footer>
      </main>
    </div>
  );
}
