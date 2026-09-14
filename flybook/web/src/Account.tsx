import { useEffect, useState } from "react";
import type { EthereumWallet, Session } from "@supabase/supabase-js";
import type { EIP1193Provider } from "viem";
import { formatUnits, getAddress, toHex } from "viem";
import { createSiweMessage, generateSiweNonce } from "viem/siwe";
import { useConnect, useConnection, useConnectors, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { getBalance, getMe, setHandle, type Me } from "./api";
import { BASE, db, tuning, type Fly, type Patch } from "./feed";
import BreedDialog from "./BreedDialog";
import Captcha, { CAPTCHA_KEY } from "./Captcha";
import FlyMaker from "./FlyMaker";
import { BUY_URL, FLYAI, erc20, robinhood } from "./wallet";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const SIGN_IN_STATEMENT = "Sign in to Flybook. This is free and sends no transaction.";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

export type Viewer = { userId: string; holder: boolean; ready: boolean } | null;

/**
 * Sign in with a wallet (Sign in with Ethereum, via Supabase) or an email magic link, and hatch flies.
 * Everyone signed in plays; $FLYAI holders make more flies and win season rewards. Accounts without a
 * wallet pick a public name first. The balance shown here is read in the browser; the API checks it on chain.
 */
export default function Account({ patches, live, onCreated, onViewer, house }: {
  patches: Patch[]; live: boolean; onCreated: () => void; house: Fly[];
  onViewer: (viewer: Viewer) => void;
}) {
  const { address, isConnected, connector, chainId } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const balance = useReadContract({
    address: FLYAI, abi: erc20, functionName: "balanceOf", chainId: robinhood.id,
    args: address ? [address] : undefined, query: { enabled: !!address, retry: 1 },
  });
  // Some networks and extensions can't reach the chain RPC from the browser, which left the balance
  // "reading…" forever. If the browser read fails, or hasn't answered in 5 s, ask the API to read it instead.
  const [serverBalance, setServerBalance] = useState<bigint | null>(null);
  const [serverFailed, setServerFailed] = useState(false);
  const browserHasIt = balance.data !== undefined;
  useEffect(() => {
    setServerBalance(null);
    setServerFailed(false);
    if (!address || browserHasIt) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getBalance(address)
        .then((r) => { if (!cancelled) setServerBalance(BigInt(r.balance)); })
        .catch(() => { if (!cancelled) setServerFailed(true); });
    }, balance.isError ? 0 : 5_000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [address, browserHasIt, balance.isError]);
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState<null | "hatch" | "preview">(null);
  const [breeding, setBreeding] = useState(false);
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaRun, setCaptchaRun] = useState(0);   // remounts the captcha: its tokens are single use

  useEffect(() => {
    if (!db) return;
    db.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = db.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session) return setMe(null);
    getMe().then(setMe).catch((e) => setError(message(e)));
  }, [session]);
  // signed in with one wallet while another is connected in the extension
  const wrongWallet = !!(me?.wallet && address && me.wallet !== address.toLowerCase());
  useEffect(() => {
    onViewer(session && me && !wrongWallet
      ? { userId: session.user.id, holder: me.holder, ready: !!(me.wallet || me.handle) } : null);
  }, [session, me, wrongWallet, onViewer]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const needCaptcha = () => {
    if (CAPTCHA_KEY && !captcha) throw new Error("Complete the check below first.");
    return captcha ?? undefined;
  };
  const usedCaptcha = () => {
    setCaptcha(null);
    setCaptchaRun((n) => n + 1);
  };

  const signIn = () =>
    run(async () => {
      if (!db || !connector || !address) throw new Error("Wallet not ready, try connecting again.");
      const captchaToken = needCaptcha();
      // sign on Robinhood Chain: switch the wallet first (wagmi adds the chain if the wallet doesn't have it)
      if (chainId !== robinhood.id) {
        try {
          await switchChain.mutateAsync({ chainId: robinhood.id });
        } catch {
          throw new Error("Switch your wallet to Robinhood Chain to sign in.");
        }
      }
      const provider = (await connector.getProvider()) as EIP1193Provider;
      // sign for the app's clean address (no #hash or ?query), so domain and URI match the Supabase allow list
      const url = new URL(`${window.location.origin}${BASE}`);
      try {
        if ((provider as { isPhantom?: boolean }).isPhantom) {
          // Phantom refuses Supabase's own message ("invalid formatting"): it has a lowercase address and no
          // nonce, both against EIP-4361. Build a spec message for Phantom only; Supabase keeps the address's
          // case in the account id, so MetaMask/Rabby stay on the lowercase message their accounts were made with.
          const chainHex = await provider.request({ method: "eth_chainId" });
          const siwe = createSiweMessage({
            domain: url.host, uri: url.href, version: "1", chainId: Number.parseInt(chainHex, 16),
            address: getAddress(address), nonce: generateSiweNonce(), issuedAt: new Date(),
            statement: SIGN_IN_STATEMENT,
          });
          const signature = await provider.request({ method: "personal_sign", params: [toHex(siwe), getAddress(address)] });
          const { error } = await db.auth.signInWithWeb3({ chain: "ethereum", message: siwe, signature, options: { captchaToken } });
          if (error) throw error;
          return;
        }
        // Supabase's wallet type also wants the address; at runtime it only calls request().
        const wallet = {
          address,
          request: provider.request.bind(provider),
          on: provider.on.bind(provider),
          removeListener: provider.removeListener.bind(provider),
        } as unknown as EthereumWallet;
        const { error } = await db.auth.signInWithWeb3({
          chain: "ethereum",
          wallet,
          statement: SIGN_IN_STATEMENT,
          options: { url: url.href, captchaToken },
        });
        if (error) throw error;
      } finally {
        if (captchaToken) usedCaptcha();
      }
    });

  const sendLink = () =>
    run(async () => {
      if (!db) throw new Error("Sign-in isn't available right now.");
      const to = email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("That doesn't look like an email address.");
      const captchaToken = needCaptcha();
      try {
        const { error } = await db.auth.signInWithOtp({
          email: to,
          options: { emailRedirectTo: `${window.location.origin}${BASE}`, shouldCreateUser: true, captchaToken },
        });
        if (error) throw error;
        setSentTo(to);
      } finally {
        if (captchaToken) usedCaptcha();
      }
    });

  const saveName = () =>
    run(async () => {
      await setHandle(name.trim());
      setMe(await getMe());
    });

  const signOut = () =>
    run(async () => {
      await db?.auth.signOut();
      if (isConnected) disconnect.mutate();
      setSentTo(null);
    });

  const created = async () => {
    setMe(await getMe());
    onCreated();
  };

  if (!live) {
    return (
      <section className="card cta" id="account">
        <h4>Make your own fly</h4>
        <p>Sign in free to make a fly, tune its senses and neurons, and watch what its brain says. $FLYAI holders make
          up to 3 flies, and every 2 weeks the top 3 holders on the season board win $FLYAI.</p>
        <a className="btn red" href={BUY_URL} target="_blank" rel="noreferrer">Get $FLYAI</a>
      </section>
    );
  }

  // the browser's read, else the API's read, else /me once signed in; undefined while nobody knows yet
  const known = balance.data ?? serverBalance ?? (me?.wallet && !wrongWallet ? BigInt(me.balance) : undefined);
  const tokens = Number(formatUnits(known ?? 0n, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const unreadable = known === undefined && balance.isError && serverFailed;
  const made = me ? me.flies.filter((f) => !f.auto_born).length : 0; // born flies don't count toward the cap
  const signedIn = !!(session && me && !wrongWallet);
  const needsName = signedIn && !me!.wallet && !me!.handle;

  return (
    <section className="card cta account" id="account">
      <h4>Make your own fly</h4>

      {session && !me && !error && <p className="fine">Loading your account…</p>}

      {signedIn && me && (
        <>
          <p className="mono small">
            {me.wallet
              ? `${short(me.wallet)} · ${known !== undefined ? `${tokens} $FLYAI` : unreadable ? "balance unavailable right now" : "reading balance…"}`
              : `${me.handle ?? "new player"} · ${me.email ?? "email account"}`}
          </p>

          {needsName ? (
            <div className="signin-email">
              <p>Pick a public name. It's shown on your comments and on the boards; your email never is.</p>
              <div className="row">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. buzz_aldrin" maxLength={20}
                       onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && saveName()} />
                <button className="btn red" disabled={busy || name.trim().length < 3} onClick={saveName}>Save</button>
              </div>
              <p className="fine">3-20 letters, digits or underscores.</p>
            </div>
          ) : (
            <>
              {me.flies.length > 0 && (
                <ul className="mine">
                  {me.flies.map((f) => (
                    <li key={f.id}>
                      <span className="dot" style={{ background: f.color }} />
                      <div>
                        {f.name}
                        <span className="tune">
                          {f.auto_born ? "born from mating · " : ""}gen {f.generation ?? 1} · Elo {f.elo ?? 1000} · {tuning(f).join(", ") || "standard"}
                        </span>
                      </div>
                      <span className={`state${f.active ? "" : " dormant"}`}>
                        {f.active ? patches.find((p) => p.id === f.patch_id)?.name ?? f.patch_id : "dormant"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {me.holder ? (
                <p className="fine">$FLYAI holder: up to {me.holder_max_flies} flies, and you can win season rewards.</p>
              ) : (
                <p className="fine">
                  Free account: {me.free_max_flies} fly, plus likes, comments, pokes and duels. Hold {me.min_tokens} $FLYAI
                  {me.wallet ? " in this wallet" : " and sign in with that wallet"} to make up to {me.holder_max_flies} and win season rewards.
                </p>
              )}
              {me.flies.some((f) => f.auto_born) && (
                <p className="fine">Flies born from mating with other people's flies don't count toward your limit.</p>
              )}
              {made >= me.max_flies && (
                <p className="fine">You've made {me.max_flies} {me.max_flies === 1 ? "fly" : "flies"}, your limit.</p>
              )}
              <div className="row">
                {made < me.max_flies && <button className="btn red" onClick={() => setMaking("hatch")}>Hatch a fly</button>}
                {made < me.max_flies && me.flies.length > 0 && <button className="btn" onClick={() => setBreeding(true)}>Breed a fly</button>}
                {!me.holder && <a className="btn" href={BUY_URL} target="_blank" rel="noreferrer">Get $FLYAI</a>}
              </div>
            </>
          )}
          <button className="more" onClick={signOut}>sign out</button>
        </>
      )}

      {wrongWallet && (
        <>
          <p className="err">You're signed in as {short(me!.wallet!)}. Sign out to switch wallets.</p>
          <button className="more" onClick={signOut}>sign out</button>
        </>
      )}

      {!session && (
        <>
          <p>Sign in free to make a fly, tune its senses and neurons, like, comment and poke. $FLYAI holders make up to 3
            flies, and every 2 weeks the top 3 holders on the season board win $FLYAI.</p>

          {!isConnected && (
            <div className="row">
              {connectors.map((c) => (
                <button key={c.uid} className="btn red" disabled={connect.isPending} onClick={() => connect.mutate({ connector: c })}>
                  {connect.isPending ? "Connecting…" : c.name === "Injected" ? "Connect wallet" : `Connect ${c.name}`}
                </button>
              ))}
              <a className="btn" href={BUY_URL} target="_blank" rel="noreferrer">Get $FLYAI</a>
            </div>
          )}
          {connect.error && <p className="err">{message(connect.error)}</p>}

          {isConnected && address && (
            <>
              <p className="mono small">
                {short(address)} · {known !== undefined ? `${tokens} $FLYAI` : unreadable ? "balance unavailable right now" : "reading balance…"}
              </p>
              {known === 0n && <p className="fine">This wallet holds no $FLYAI yet: you can still sign in and make {1} fly.</p>}
              <div className="row">
                <button className="btn red" disabled={busy} onClick={signIn}>{busy ? "Check your wallet…" : "Sign in with wallet"}</button>
                <button className="more" onClick={() => disconnect.mutate()}>disconnect</button>
              </div>
            </>
          )}

          <div className="signin-email">
            <p className="or">or with email, no wallet needed</p>
            {sentTo ? (
              <p>Check your inbox: we sent a sign-in link to <b>{sentTo}</b>. <button className="more" onClick={() => setSentTo(null)}>use another email</button></p>
            ) : (
              <div className="row">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"
                       onKeyDown={(e) => e.key === "Enter" && email.trim() && !busy && sendLink()} />
                <button className="btn" disabled={busy || !email.trim()} onClick={sendLink}>Email me a link</button>
              </div>
            )}
          </div>
          <Captcha key={captchaRun} onToken={setCaptcha} />
        </>
      )}

      {error && <p className="err">{error}</p>}

      {!(signedIn && !needsName && made < (me?.max_flies ?? 0)) && (
        <button className="more" onClick={() => setMaking("preview")}>browse the fly profiles</button>
      )}
      {breeding && me && (
        <BreedDialog mine={me.flies as Fly[]} house={house} patches={patches} onClose={() => setBreeding(false)} onCreated={created} />
      )}
      {making && (
        <FlyMaker patches={patches} canHatch={making === "hatch"} onClose={() => setMaking(null)} onCreated={created} />
      )}
    </section>
  );
}
