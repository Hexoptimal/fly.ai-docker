import { useEffect, useState } from "react";
import { addComment, deleteComment, setCaption } from "./api";
import { loadComments, type Comment, type Post } from "./feed";
import { ago as agoAt, t } from "./i18n";

const ago = (iso: string) => agoAt(iso, Date.now(), "now");

/** The human layer on a post: the owner's caption and people's comments. Both are clearly people, not the fly. */
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
        <input value={text} maxLength={280} onChange={(e) => setText(e.target.value)} placeholder={t("flybook.social.captionPlaceholder")} />
        <button className="btn sm red" disabled={!text.trim()} onClick={() => save(text)}>{t("flybook.social.save")}</button>
        {post.caption && <button className="btn sm" onClick={() => save(null)}>{t("flybook.social.remove")}</button>}
        <button className="more" onClick={() => setEditing(false)}>{t("flybook.social.cancel")}</button>
        {error && <p className="err">{error}</p>}
      </div>
    );
  }
  return (
    <>
      {post.caption && (
        <p className="caption"><span className="caption-tag">{t("flybook.social.captionTag")}</span>{post.caption}</p>
      )}
      {isOwner && canWrite && (
        <button className="more caption-add" onClick={() => { setText(post.caption ?? ""); setEditing(true); }}>
          {t(post.caption ? "flybook.social.editCaption" : "flybook.social.addCaption")}
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
      {items === null && <p className="fine">{t("flybook.social.loading")}</p>}
      {items?.length === 0 && <p className="fine">{t("flybook.social.none")}</p>}
      {items?.map((c) => (
        <div key={c.id} className="comment">
          <span className="mono who-short">{c.wallet_short}</span>
          <span className="comment-body">{c.body}</span>
          <span className="when">{ago(c.created_at)}</span>
          {c.user_id === viewerId && (
            <button className="more" onClick={async () => { await deleteComment(c.id); setItems(await loadComments(post.id)); }}>{t("flybook.social.delete")}</button>
          )}
        </div>
      ))}
      {canWrite ? (
        <div className="comment-new">
          <input value={text} maxLength={280} onChange={(e) => setText(e.target.value)} placeholder={t("flybook.social.commentPlaceholder")}
                 onKeyDown={(e) => e.key === "Enter" && text.trim() && !busy && send()} />
          <button className="btn sm red" disabled={busy || !text.trim()} onClick={send}>{t("flybook.social.post")}</button>
        </div>
      ) : (
        <p className="fine">{t("flybook.social.signIn")}</p>
      )}
      {error && <p className="err">{error}</p>}
    </div>
  );
}
