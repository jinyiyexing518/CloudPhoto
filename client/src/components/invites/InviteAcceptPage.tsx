import { useState, useEffect } from "react";
import { getInviteApi, respondInviteApi, InviteInfo } from "../../services/groupApi";
import { useAuth } from "../../contexts/AuthContext";
import { useGroup } from "../../contexts/GroupContext";

interface Props {
  token: string;
  onDone: () => void; // called after accept/decline — removes ?invite= from URL
}

export default function InviteAcceptPage({ token, onDone }: Props) {
  const { user } = useAuth();
  const { refreshGroups } = useGroup();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  useEffect(() => {
    getInviteApi(token)
      .then(setInvite)
      .catch((e) => setLoadError(e instanceof Error ? e.message : "邀请加载失败"));
  }, [token]);

  const respond = async (action: "accept" | "decline") => {
    setBusy(true);
    try {
      const res = await respondInviteApi(token, action);
      if (action === "accept") await refreshGroups();
      setResult({ type: "success", msg: res.message });
    } catch (e) {
      setResult({ type: "error", msg: e instanceof Error ? e.message : "操作失败" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay">
      <div className="invite-card">
        <div className="invite-logo">📷 Cloud Photo</div>

        {loadError && (
          <>
            <div className="invite-error">{loadError}</div>
            <button className="invite-btn-secondary" onClick={onDone}>返回首页</button>
          </>
        )}

        {result && (
          <>
            <div className={result.type === "success" ? "invite-success" : "invite-error"}>
              {result.type === "success" ? "✅ " : "❌ "}{result.msg}
            </div>
            <button className="invite-btn-primary" onClick={onDone}>进入 Cloud Photo</button>
          </>
        )}

        {!loadError && !result && invite && (
          <>
            {invite.status !== "pending" ? (
              <>
                <div className="invite-error">
                  此邀请已{invite.status === "accepted" ? "被接受" : invite.status === "declined" ? "被拒绝" : "失效"}
                </div>
                <button className="invite-btn-secondary" onClick={onDone}>返回首页</button>
              </>
            ) : (
              <>
                <div className="invite-title">你收到了一个群组邀请</div>
                <div className="invite-body">
                  <p>
                    <strong>{invite.invitedByName}</strong> 邀请你加入群组
                    <strong>「{invite.groupName}」</strong>
                  </p>
                  {user ? (
                    user.email?.toLowerCase() !== invite.email ? (
                      <div className="invite-warn">
                        ⚠️ 此邀请发送给 <strong>{invite.email}</strong>，
                        你当前登录的账号邮箱为 <strong>{user.email}</strong>，不匹配。
                        <br />请切换到正确的账号后再接受邀请。
                      </div>
                    ) : (
                      <p className="invite-hint">接受后即可在群组中查看和上传照片。</p>
                    )
                  ) : (
                    <p className="invite-hint">
                      请先登录邮箱为 <strong>{invite.email}</strong> 的账号，再接受邀请。
                    </p>
                  )}
                </div>
                <div className="invite-actions">
                  <button
                    className="invite-btn-primary"
                    disabled={busy || !user || user.email?.toLowerCase() !== invite.email}
                    onClick={() => respond("accept")}
                  >
                    {busy ? "处理中…" : "接受邀请"}
                  </button>
                  <button
                    className="invite-btn-secondary"
                    disabled={busy || !user || user.email?.toLowerCase() !== invite.email}
                    onClick={() => respond("decline")}
                  >
                    拒绝
                  </button>
                  <button className="invite-btn-ghost" onClick={onDone}>
                    稍后再说
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {!loadError && !result && !invite && !loadError && (
          <div className="invite-loading">加载邀请信息…</div>
        )}
      </div>
    </div>
  );
}
