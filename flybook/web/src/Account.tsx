import { useEffect, useState } from "react";
import type { EthereumWallet, Session } from "@supabase/supabase-js";
import type { EIP1193Provider } from "viem";
import { formatUnits, getAddress, toHex } from "viem";
import { createSiweMessage, generateSiweNonce } from "viem/siwe";
import { useConnect, useConnection, useConnectors, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { getBalance, getMe, type Me } from "./api";
import { BASE, db, tuning, type Fly, type Patch } from "./feed";
import BreedDialog from "./BreedDialog";
import FlyMaker from "./FlyMaker";
import { BUY_URL, FLYAI, erc20, robinhood } from "./wallet";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const SIGN_IN_STATEMENT = "Sign in to Flybook. This is free and sends no transaction.";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

/**
 * Connect a wallet, sign in with it (Sign in with Ethereum, via Supabase), and hatch flies.
 * The balance shown here is read in the browser; the API checks it again on chain before
 * it creates anything.
 */
export default function Account({ patches, live, onCreated, onViewer, house }: {
  patches: Patch[]; live: boolean; onCreated: () => void; house: Fly[];
  onViewer: (viewer: { userId: string; holder: boolean } | null) => void;
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
  // "reading…" forever and hid the sign-in button. If the browser read fails, or hasn't answered in
  // 5 s, ask the API to read it instead.
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
  useEffect(() => {
    const otherWallet = !!(me && address && me.wallet !== address.toLowerCase());
    onViewer(session && me && !otherWallet ? { userId: session.user.id, holder: me.holder } : null);
  }, [session, me, address, onViewer]);

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

  const signIn = () =>
    run(async () => {
      if (!db || !connector || !address) throw new Error("Wallet not ready, try connecting again.");
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
        const { error } = await db.auth.signInWithWeb3({ chain: "ethereum", message: siwe, signature });
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
        options: { url: url.href },
      });
      if (error) throw error;
    });

  const signOut = () =>
    run(async () => {
      await db?.auth.signOut();
      disconnect.mutate();
    });

  const created = async () => {
    setMe(await getMe());
    onCreated();
  };

  if (!live) {
    return (
      <section className="card cta" id="account">
        <h4>Make your own fly</h4>
        <p>$FLYAI holders can create a fly, tune its senses and neurons, and watch what its brain says. Every 2 weeks the
          top 3 players win $FLYAI.</p>
        <a className="btn red" href={BUY_URL} target="_blank" rel="noreferrer">Get $FLYAI</a>
      </section>
    );
  }

  const wrongWallet = !!(me && address && me.wallet !== address.toLowerCase());
  // the browser's read, else the API's read, else /me once signed in; undefined while nobody knows yet
  const known = balance.data ?? serverBalance ?? (me && !wrongWallet ? BigInt(me.balance) : undefined);
  const tokens = Number(formatUnits(known ?? 0n, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const unreadable = known === undefined && balance.isError && serverFailed;
  const made = me ? me.flies.filter((f) => !f.auto_born).length : 0; // born flies don't count toward the cap

  return (
    <section className="card cta account" id="account">
      <h4>Make your own fly</h4>

      {!isConnected && (
        <>
          <p>$FLYAI holders can create a fly, tune its senses and neurons, and watch what its brain says. Every 2 weeks the
            top 3 players win $FLYAI.</p>
          <div className="row">
            {connectors.map((c) => (
              <button key={c.uid} className="btn red" disabled={connect.isPending} onClick={() => connect.mutate({ connector: c })}>
                {connect.isPending ? "Connecting…" : c.name === "Injected" ? "Connect wallet" : `Connect ${c.name}`}
              </button>
            ))}
            <a className="btn" href={BUY_URL} target="_blank" rel="noreferrer">Get $FLYAI</a>
          </div>
          {connect.error && <p className="err">{message(connect.error)}</p>}
        </>
      )}

      {isConnected && address && (
        <>
          <p className="mono small">
            {short(address)} · {known !== undefined ? `${tokens} $FLYAI` : unreadable ? "balance unavailable right now" : "reading balance…"}
          </p>

          {!session && known === 0n && (
            <>
              <p>This wallet doesn't hold $FLYAI yet. Holders can make a fly.</p>
              <a className="btn red" href={BUY_URL} target="_blank" rel="noreferrer">Get $FLYAI</a>
            </>
          )}

          {/* unless we know it's zero: the API checks the balance on chain again after sign-in */}
          {!session && known !== 0n && (
            <button className="btn red" disabled={busy} onClick={signIn}>
              {busy ? "Check your wallet…" : "Sign in to make a fly"}
            </button>
          )}

          {wrongWallet && <p className="err">You're signed in as {short(me!.wallet)}. Sign out to switch wallets.</p>}

          {session && me && !wrongWallet && (
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
              {!me.holder && (
                <p>
                  You need at least {me.min_tokens} $FLYAI to make a fly. Flies whose owner drops below that go dormant
                  until they hold again.
                </p>
              )}
              {me.flies.some((f) => f.auto_born) && (
                <p className="fine">Flies born from mating with other people's flies don't count toward your limit.</p>
              )}
              {me.holder && made >= me.max_flies && (
                <p className="fine">You've made {me.max_flies} flies, the most one wallet can make.</p>
              )}
              {me.holder && made < me.max_flies && (
                <div className="row">
                  <button className="btn red" onClick={() => setMaking("hatch")}>Hatch a fly</button>
                  {me.flies.length > 0 && <button className="btn" onClick={() => setBreeding(true)}>Breed a fly</button>}
                </div>
              )}
            </>
          )}

          {error && <p className="err">{error}</p>}
          <button className="more" onClick={signOut}>{session ? "sign out" : "disconnect"}</button>
        </>
      )}

      {!(session && me?.holder) && (
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
