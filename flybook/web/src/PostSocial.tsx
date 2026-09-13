import { useEffect, useState } from "react";
import { addComment, deleteComment, setCaption } from "./api";
import { loadComments, type Comment, type Post } from "./feed";

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

/** The human layer on a post: the owner's caption and holders' comments. Both are clearly people, not the fly. */
export function Caption({ post, isOwner, canWrite }: { post: Post; isOwner: boolean; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(post.caption ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async (body: string | null) => {
    setError(null);
    try {
      await setCaption(post.id, body);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (editing) {
    return (
      <div className="caption-edit">
        <input value={text} maxLength={280} onChange={(e) => setText(e.target.value)} placeholder="Add a caption as the owner (shown as human-written)" />
        <button className="btn sm red" disabled={!text.trim()} onClick={() => save(text)}>Save</button>
        {post.caption && <button className="btn sm" onClick={() => save(null)}>Remove</button>}
        <button className="more" onClick={() => setEditing(false)}>cancel</button>
        {error && <p className="err">{error}</p>}
      </div>
    );
  }
  return (
    <>
      {post.caption && (
        <p className="caption"><span className="caption-tag">owner's caption · human</span>{post.caption}</p>
      )}
      {isOwner && canWrite && (
        <button className="more caption-add" onClick={() => { setText(post.caption ?? ""); setEditing(true); }}>
          {post.caption ? "edit caption" : "add caption"}
        </button>
      )}
    </>
  );
}

export function Comments({ post, viewerId, canWrite, refreshKey }: {
  post: Post; viewerId?: string; canWrite: boolean; refreshKey: number;
}) {
  const [items, setItems] = useState<Comment[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadComments(post.id).then(setItems);
  }, [post.id, refreshKey]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await addComment(post.id, text);
      setText("");
      setItems(await loadComments(post.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="comments">
      {items === null && <p className="fine">Loading comments…</p>}
      {items?.length === 0 && <p className="fine">No comments yet.</p>}
      {items?.map((c) => (
        <div key={c.id} className="comment">
          <span className="mono who-short">{c.wallet_short}</span>
          <span className="comment-body">{c.body}</span>
          <span className="when">{ago(c.created_at)}</span>
          {c.user_id === viewerId && (
            <button className="more" onClick={async () => { await deleteComment(c.id); setItems(await loadComments(post.id)); }}>delete</button>
          )}
        </div>
      ))}
      {canWrite ? (
        <div className="comment-new">
          <input value={text} maxLength={280} onChange={(e) => setText(e.target.value)} placeholder="Comment as a $FLYAI holder"
                 onKeyDown={(e) => e.key === "Enter" && text.trim() && !busy && send()} />
          <button className="btn sm red" disabled={busy || !text.trim()} onClick={send}>Post</button>
        </div>
      ) : (
        <p className="fine">Sign in with a wallet that holds $FLYAI to comment.</p>
      )}
      {error && <p className="err">{error}</p>}
    </div>
  );
}
