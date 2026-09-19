import { useEffect, useState } from "react";
import { formatUnits, parseAbi, type Address } from "viem";
import { useConnect, useConnection, useConnectors } from "wagmi";
import { readContract, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { BUY_URL, FLYAI, robinhood, wagmiConfig } from "./wallet";

/**
 * Trader Flies: the genesis NFT mint. Each token is a connectome fly for the trading desk. Paid in USDG (the chain's
 * dollar), or in $FLYAI at a discount. Talks to the TraderFly contract straight from the wallet (no API).
 * VITE_TRADERFLY sets the contract; without it the tab explains the collection and says the mint is coming.
 */
export const TRADERFLY = (import.meta.env.VITE_TRADERFLY as Address | undefined) || undefined;
const ALLOWLIST = `${import.meta.env.BASE_URL}traderfly-allowlist.json`;
const GATEWAY = "https://gateway.pinata.cloud/ipfs/";

const fly = parseAbi([
  "function MAX_SUPPLY() view returns (uint256)", "function totalMinted() view returns (uint256)",
  "function phase() view returns (uint8)", "function publicPrice() view returns (uint256)",
  "function allowlistPrice() view returns (uint256)", "function maxPerWallet() view returns (uint256)",
  "function mintedBy(address) view returns (uint256)", "function USD() view returns (address)",
  "function revealed() view returns (bool)", "function flyaiDiscountBps() view returns (uint256)",
  "function quoteFlyai(uint256) view returns (uint256)", "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)", "function isActive(uint256) view returns (bool)",
  "function mint(uint256)", "function mintWithFlyai(uint256, uint256)",
  "function allowlistMint(uint256, bytes32[])", "function allowlistMintWithFlyai(uint256, bytes32[], uint256)",
  "function activate(uint256)", "function deactivate(uint256)",
  "error MintClosed()", "error NotAllowlisted()", "error SoldOut()", "error WalletLimit()", "error ZeroQuantity()",
  "error PaymentShort()", "error NotHolder()", "error AlreadyRevealed()", "error PriceStale()", "error TooMuchFlyai()",
  "error NoProvenance()",
]);
const token = parseAbi([
  "function balanceOf(address) view returns (uint256)", "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)", "function decimals() view returns (uint8)",
  "error ERC20InsufficientBalance(address, uint256, uint256)", "error ERC20InsufficientAllowance(address, uint256, uint256)",
]);
const WHY: Record<string, string> = {
  MintClosed: "Minting isn't open right now.", NotAllowlisted: "This wallet isn't on the allowlist.",
  SoldOut: "Not enough flies left for that many.", WalletLimit: "That's more than one wallet can mint.",
  AlreadyRevealed: "Minting has ended.", NotHolder: "You don't hold that fly.",
  PriceStale: "Paying in $FLYAI is paused for a moment (the price is updating). Try again soon, or pay in USDG.",
  TooMuchFlyai: "The $FLYAI price just moved. Check the new amount and try again.",
  ERC20InsufficientBalance: "Not enough in this wallet.", NoProvenance: "Minting hasn't started yet.",
};
const PHASE = ["Not open yet", "Allowlist", "Open"];

type Pay = "usd" | "flyai";
type State = {
  max: bigint; minted: bigint; phase: number; price: bigint; perWallet: bigint; revealed: boolean; discount: number;
  usd: Address; usdDecimals: number; flyaiCost: bigint | null;   // per fly; null: paying in FLYAI is paused
  mine: bigint; usdBalance: bigint; flyaiBalance: bigint;
};
type Mine = { id: bigint; active: boolean; image: string | null; name: string | null; rarity: string | null };

const read = <T,>(address: Address, abi: typeof fly | typeof token, functionName: string, args: unknown[] = []) =>
  readContract(wagmiConfig, { address, abi, functionName, args, chainId: robinhood.id } as never) as Promise<T>;
const whole = (v: bigint, decimals: number, digits = 2) =>
  Number(formatUnits(v, decimals)).toLocaleString("en-US", { maximumFractionDigits: digits });
const ipfs = (u: string) => (u.startsWith("ipfs://") ? GATEWAY + u.slice(7) : u);
function reason(e: unknown): string {
  const err = e as { cause?: { data?: { errorName?: string } }; shortMessage?: string; message?: string };
  const name = err?.cause?.data?.errorName;
  if (name && WHY[name]) return WHY[name];
  const m = err?.shortMessage ?? err?.message ?? String(e);
  if (/rejected|denied/i.test(m)) return "Cancelled in the wallet.";
  if (/exceeds the balance|insufficient funds/i.test(m)) return "Not enough ETH in this wallet to pay the network fee.";
  return m.split("\n")[0];
}

export default function TraderFlies() {
  const { address, chainId } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const [s, setS] = useState<State | null>(null);
  const [pay, setPay] = useState<Pay>("usd");
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);
  const [allowlist, setAllowlist] = useState<Record<string, `0x${string}`[]> | null>(null);
  const [mine, setMine] = useState<Mine[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch(ALLOWLIST).then((r) => (r.ok ? r.json() : null)).then((j) => setAllowlist(j?.proofs ?? null)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!TRADERFLY) return;
    let gone = false;
    const load = async () => {
      const c = TRADERFLY!;
      const [max, minted, phase, pub, al, perWallet, revealed, disc, usd] = await Promise.all([
        read<bigint>(c, fly, "MAX_SUPPLY"), read<bigint>(c, fly, "totalMinted"), read<number>(c, fly, "phase"),
        read<bigint>(c, fly, "publicPrice"), read<bigint>(c, fly, "allowlistPrice"), read<bigint>(c, fly, "maxPerWallet"),
        read<boolean>(c, fly, "revealed"), read<bigint>(c, fly, "flyaiDiscountBps"), read<Address>(c, fly, "USD")]);
      const [usdDecimals, flyaiCost] = await Promise.all([read<number>(usd, token, "decimals"),
        read<bigint>(c, fly, "quoteFlyai", [1n]).catch(() => null)]);
      const [mineCount, usdBalance, flyaiBalance] = address ? await Promise.all([
        read<bigint>(c, fly, "mintedBy", [address]), read<bigint>(usd, token, "balanceOf", [address]),
        read<bigint>(FLYAI, token, "balanceOf", [address])]) : [0n, 0n, 0n];
      if (gone) return;
      setS({ max, minted, phase: Number(phase), price: Number(phase) === 1 ? al : pub, perWallet, revealed,
        discount: Number(disc) / 100, usd, usdDecimals, flyaiCost, mine: mineCount, usdBalance, flyaiBalance });
    };
    load().catch((e) => setMsg({ text: `Can't read the mint right now. ${reason(e)}` }));
    const t = setInterval(() => { if (!busy) load().catch(() => {}); }, 15_000);
    return () => { gone = true; clearInterval(t); };
  }, [address, tick]);

  // the connected wallet's flies
  useEffect(() => {
    if (!TRADERFLY || !address || !s || s.minted === 0n) { setMine([]); return; }
    let gone = false;
    (async () => {
      const ids = Array.from({ length: Number(s.minted) }, (_, i) => BigInt(i + 1));
      const owners = await Promise.all(ids.map((id) => read<Address>(TRADERFLY!, fly, "ownerOf", [id])));
      const own = ids.filter((_, i) => owners[i].toLowerCase() === address.toLowerCase());
      const rows = await Promise.all(own.map(async (id) => {
        const [uri, active] = await Promise.all([read<string>(TRADERFLY!, fly, "tokenURI", [id]), read<boolean>(TRADERFLY!, fly, "isActive", [id])]);
        const meta = uri ? await fetch(ipfs(uri)).then((r) => r.json()).catch(() => null) : null;
        // the metadata is built on chain (a data: URI) with the rolled traits; only the image is on IPFS
        const trait = (k: string) => (meta?.attributes as { trait_type: string; value: string }[] | undefined)?.find((a) => a.trait_type === k)?.value ?? null;
        return { id, active, image: meta?.image ? ipfs(meta.image) : null, name: meta?.name ?? null, rarity: s.revealed ? trait("Rarity") : null };
      }));
      if (!gone) setMine(rows);
    })().catch(() => {});
    return () => { gone = true; };
  }, [address, s?.minted, s?.revealed, tick]);

  if (!TRADERFLY) {
    return (
      <div className="traders">
        <Head />
        <How discount={15} />
        <p className="fine traders-soon">The mint opens soon.</p>
      </div>
    );
  }

  const listed = s?.phase === 1 ? !!allowlist?.[address?.toLowerCase() ?? ""] : true;
  const room = s ? Math.max(0, Number(s.max - s.minted < s.perWallet - s.mine ? s.max - s.minted : s.perWallet - s.mine)) : 0;
  const n = Math.min(Math.max(qty, 1), Math.max(room, 1));
  const cost = !s ? null : pay === "usd" ? s.price * BigInt(n) : s.flyaiCost == null ? null : s.flyaiCost * BigInt(n);
  const balance = !s ? 0n : pay === "usd" ? s.usdBalance : s.flyaiBalance;
  const costText = !s || cost == null ? "–" : pay === "usd" ? `$${whole(cost, s.usdDecimals)}` : `${whole(cost, 18, 0)} $FLYAI`;
  const why = !s ? null
    : s.revealed || s.minted >= s.max ? "Minting has ended."
    : s.phase === 0 ? "Minting isn't open yet."
    : !address ? null
    : !listed ? "This wallet isn't on the allowlist. The open mint comes after."
    : room < 1 ? `You've minted your ${s.perWallet}.`
    : cost == null ? WHY.PriceStale
    : balance < cost ? (pay === "usd" ? `You need ${costText} in USDG.` : `You need ${costText}.`)
    : null;

  const send = async (to: Address, abi: typeof fly | typeof token, functionName: string, args: unknown[], label: string) => {
    const hash = await writeContract(wagmiConfig, { address: to, abi, functionName, args, chainId: robinhood.id } as never);
    setMsg({ text: `${label}: waiting for the block…` });
    const r = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: robinhood.id });
    if (r.status !== "success") throw new Error("The transaction failed on chain.");
  };

  const mint = async () => {
    if (!s || !address || cost == null) return;
    setBusy("mint");
    setMsg(null);
    try {
      if (chainId !== robinhood.id) await switchChain(wagmiConfig, { chainId: robinhood.id });
      const payToken = pay === "usd" ? s.usd : FLYAI;
      const limit = pay === "usd" ? cost : cost + cost / 50n;   // 2% room if the FLYAI price updates first
      const allowed = await read<bigint>(payToken, token, "allowance", [address, TRADERFLY]);
      if (allowed < limit) {
        setMsg({ text: "Step 1 of 2: approve the payment in your wallet." });
        await send(payToken, token, "approve", [TRADERFLY, limit], "Approving");
        setMsg({ text: "Step 2 of 2: confirm the mint in your wallet." });
      } else setMsg({ text: "Confirm the mint in your wallet." });
      const proof = s.phase === 1 ? allowlist?.[address.toLowerCase()] : null;
      const [fn, args] = pay === "usd"
        ? (proof ? ["allowlistMint", [BigInt(n), proof]] : ["mint", [BigInt(n)]])
        : (proof ? ["allowlistMintWithFlyai", [BigInt(n), proof, limit]] : ["mintWithFlyai", [BigInt(n), limit]]);
      await send(TRADERFLY, fly, fn as string, args as unknown[], "Minting");
      setMsg({ text: `Minted ${n} ${n === 1 ? "fly" : "flies"}. ${s.revealed ? "" : "Your art is revealed when minting ends."}`, ok: true });
      setTick((t) => t + 1);
    } catch (e) {
      setMsg({ text: reason(e) });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (m: Mine) => {
    setBusy(`fly-${m.id}`);
    try {
      if (chainId !== robinhood.id) await switchChain(wagmiConfig, { chainId: robinhood.id });
      await send(TRADERFLY, fly, m.active ? "deactivate" : "activate", [m.id], m.active ? "Deactivating" : "Activating");
      setMsg({ text: `Trader Fly #${m.id} ${m.active ? "is idle" : "is on the desk"}.`, ok: true });
      setTick((t) => t + 1);
    } catch (e) {
      setMsg({ text: reason(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="traders">
      <Head />
      <section className="traders-mint">
        <img src={`${import.meta.env.BASE_URL}traderfly-preview.png`} alt="A Trader Fly"
          onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }} />
        <div>
          <div className="traders-stats">
            <div><b className="mono">{s ? `${s.minted} / ${s.max}` : "–"}</b><span>minted</span></div>
            <div><b className="mono">{s ? `$${whole(s.price, s.usdDecimals)}` : "–"}</b><span>{s?.phase === 1 ? "allowlist price" : "price"}</span></div>
            <div><b>{s ? (s.revealed ? "Revealed" : PHASE[s.phase]) : "–"}</b><span>status</span></div>
          </div>
          <div className="traders-bar"><i style={{ width: s ? `${Number((s.minted * 100n) / (s.max || 1n))}%` : 0 }} /></div>

          <h5>Pay with</h5>
          <div className="seg traders-pay">
            <button className={pay === "usd" ? "on" : ""} onClick={() => setPay("usd")} disabled={!!busy}>USDG</button>
            <button className={pay === "flyai" ? "on" : ""} onClick={() => setPay("flyai")} disabled={!!busy}>
              $FLYAI · {s?.discount ?? 15}% off
            </button>
          </div>
          {pay === "flyai" && s && s.flyaiBalance === 0n && address && (
            <p className="fine">$FLYAI holders get {s.discount}% off. <a href={BUY_URL} target="_blank" rel="noreferrer">Buy $FLYAI →</a></p>
          )}

          <div className="traders-row">
            {!address ? (
              <div className="traders-connect">
                {connectors.map((c) => (
                  <button key={c.uid} className="btn red" disabled={connect.isPending} onClick={() => connect.mutate({ connector: c })}>
                    Connect {c.name === "Injected" ? "wallet" : c.name}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <div className="traders-qty">
                  <button aria-label="Fewer" onClick={() => setQty(Math.max(1, n - 1))} disabled={!!busy}>−</button>
                  <output className="mono">{n}</output>
                  <button aria-label="More" onClick={() => setQty(Math.min(Math.max(room, 1), n + 1))} disabled={!!busy}>+</button>
                </div>
                <button className="btn red" onClick={mint} disabled={!!busy || !!why || !s}>
                  {busy === "mint" ? "Minting…" : `Mint ${n} · ${costText}`}
                </button>
              </>
            )}
          </div>
          {address && s && (
            <p className="fine mono">
              {address.slice(0, 6)}…{address.slice(-4)} · ${whole(s.usdBalance, s.usdDecimals)} USDG · {whole(s.flyaiBalance, 18, 0)} $FLYAI
            </p>
          )}
          {(msg || why) && <p className={msg?.ok ? "ok" : msg || why ? "err" : ""}>{msg?.text ?? why}</p>}
        </div>
      </section>

      <How discount={s?.discount ?? 15} />

      {mine.length > 0 && (
        <section>
          <h3 className="merch-sub">Your Trader Flies</h3>
          <div className="traders-grid">
            {mine.map((m) => (
              <article key={String(m.id)} className="traders-card">
                <img src={m.image ?? `${import.meta.env.BASE_URL}traderfly-preview.png`} alt="" loading="lazy" />
                <b>{m.name ?? `Trader Fly #${m.id}`}</b>
                {m.rarity && <span className={`traders-rarity ${m.rarity.toLowerCase()}`}>{m.rarity}</span>}
                <span className={`mono ${m.active ? "on" : ""}`}>{m.active ? "● on the desk" : "○ idle"}</span>
                <button className={`btn sm ${m.active ? "" : "red"}`} onClick={() => toggle(m)} disabled={!!busy}>
                  {busy === `fly-${m.id}` ? "…" : m.active ? "Deactivate" : "Activate"}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Head() {
  return (
    <div className="feed-head">
      <h2>Trader Flies</h2>
      <p>
        A genesis collection of trading flies. Each one is a real fruit-fly connectome that trades on Robinhood Chain.
        Mint one, and your fly is revealed when minting ends. Activate it to put it on the desk.
      </p>
    </div>
  );
}

function How({ discount }: { discount: number }) {
  return (
    <ol className="traders-how">
      <li><b>Mint</b> in USDG, or in $FLYAI for {discount}% off. While minting is open every fly looks the same, so nobody can pick the rare ones.</li>
      <li><b>Reveal.</b> When minting ends, a future block's hash rolls every fly's traits in the contract itself: rarity (Common, Uncommon, Rare or Legendary), pose, colorway, background and gear. Anyone can check them on chain.</li>
      <li><b>Activate.</b> Active flies trade together on the desk. When a week ends in profit, active flies share it in $FLYAI, weighted by rarity and by how long they were active.</li>
      <li className="fine">Trading can lose money, and a week without profit pays nothing. Nothing here promises a return.</li>
    </ol>
  );
}
