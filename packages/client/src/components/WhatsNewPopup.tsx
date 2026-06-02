import { useState } from "react";
import { createPortal } from "react-dom";

export interface ChangelogEntry {
  id: string;
  date: string; // "YYYY-MM-DD"
  icon: string;
  title: string;
  desc: string;
  details?: string; // 展开后显示的详细内容
}

// ─── Changelog — newest first ────────────────────────────────────────────────
export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "video-thumbnail-crop",
    date: "2026-06-02",
    icon: "🖼️",
    title: "视频缩略图居中裁剪",
    desc: "视频封面以帧的中心居中裁剪填满格子，不再显示边角",
    details:
      "之前视频缩略图会把整帧压缩进正方形格子，横/竖屏视频都会出现黑边或拉伸。现在使用 object-fit: cover + object-position: center，与图片缩略图行为完全一致，封面始终取帧的中央区域，不改变原始比例。",
  },
  {
    id: "modal-centering",
    date: "2026-06-02",
    icon: "📱",
    title: "详情弹窗垂直居中",
    desc: "点击照片/视频打开详情页时，弹窗在移动端垂直居中显示",
    details:
      "此前移动端详情弹窗总是出现在页面顶部，用户需要滚动才能看到完整内容。现在改用 margin: auto 在 flex 容器中居中，内容适合屏幕时自动居中；内容超出屏幕高度时从顶部开始可滚动，两种情况均处理正确。",
  },
  {
    id: "delete-progress",
    date: "2026-06-02",
    icon: "🗑️",
    title: "删除与清空进度条",
    desc: "批量删除照片和清空回收站时显示实时进度条",
    details:
      "批量选中后执行删除，页面顶部会出现进度条（复用上传进度的样式），显示「删除中 X/总数」和百分比，逐张处理完成后自动消失。回收站「清空回收站」操作在对话框内显示内联进度块，清空过程中按钮禁用防止重复点击。",
  },
  {
    id: "dialog-centering",
    date: "2026-06-01",
    icon: "📐",
    title: "删除确认弹窗居中",
    desc: "删除确认弹窗现在始终显示在屏幕正中央",
    details:
      "之前删除确认弹窗在部分场景（尤其是有 CSS transform 的父元素内）会出现在视口底部或偏移位置。现在改用 React createPortal 直接渲染到 document.body，始终固定居中。",
  },
  {
    id: "folder-persist",
    date: "2026-05-30",
    icon: "📁",
    title: "文件夹路径记忆",
    desc: "刷新页面后自动回到上次浏览的文件夹位置",
    details:
      "此前刷新页面会重置到文件夹根目录，需要重新点击进入。现在使用惰性 useState 初始器在组件挂载时直接从 localStorage 读取上次路径，刷新后立即恢复，无需任何额外操作。",
  },
  {
    id: "voice-memo",
    date: "2026-05-30",
    icon: "🎙️",
    title: "语音备注",
    desc: "为每张照片录制语音备注，随时回听",
    details:
      "在照片/视频详情弹窗的操作栏点击 🎤 语音，即可录制一段语音备注。支持 webm（Chrome/Android）和 mp4（Safari/iOS）。已有备注时按钮显示为「🎤 备注✓」，面板内有播放器可直接收听，也可删除备注。",
  },
  {
    id: "video-upload",
    date: "2026-05-30",
    icon: "🎬",
    title: "视频上传",
    desc: "现在可以上传视频文件，与照片一同保存在相册中",
    details:
      "支持格式：MP4 / MOV / WebM / AVI / MPEG / 3GPP，单文件最大 200 MB（图片仍为 20 MB）。视频卡片右下角显示 ▶ 标识，点击可在详情弹窗中直接播放。缩略图自动定位到视频约 10% 时长处的代表性帧。",
  },
];

const STORAGE_KEY = "cf_whats_new_seen";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function getRecentEntries(): ChangelogEntry[] {
  const now = Date.now();
  return CHANGELOG.filter((e) => now - new Date(e.date).getTime() <= SEVEN_DAYS_MS);
}

function mostRecentDate(entries: ChangelogEntry[]): string {
  return entries.reduce((max, e) => (e.date > max ? e.date : max), "");
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

export default function WhatsNewPopup() {
  const recent = getRecentEntries();
  const latestDate = mostRecentDate(recent);
  const lastSeen = localStorage.getItem(STORAGE_KEY) ?? "";
  const shouldShow = recent.length > 0 && latestDate > lastSeen;

  const [visible, setVisible] = useState(shouldShow);
  const [closing, setClosing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, latestDate);
    setClosing(true);
    setTimeout(() => setVisible(false), 300);
  };

  if (!visible) return null;

  return createPortal(
    <div
      className={`whats-new-overlay${closing ? " whats-new-overlay--out" : ""}`}
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
      role="dialog"
      aria-modal="true"
      aria-label="最近更新"
    >
      <div className="whats-new-popup">
        <div className="whats-new-header">
          <div className="whats-new-header-text">
            <span className="whats-new-title">🎉 最近更新</span>
            <span className="whats-new-subtitle">过去 7 天新上线的功能，点击条目查看详情</span>
          </div>
          <button className="whats-new-close" onClick={dismiss} aria-label="关闭">✕</button>
        </div>
        <ul className="whats-new-list">
          {recent.map((entry) => {
            const open = expandedId === entry.id;
            return (
              <li key={entry.id} className="whats-new-item">
                <div
                  className="whats-new-item-summary"
                  onClick={() => setExpandedId(open ? null : entry.id)}
                  role="button"
                  aria-expanded={open}
                >
                  <span className="whats-new-icon">{entry.icon}</span>
                  <div className="whats-new-body">
                    <div className="whats-new-item-top">
                      <span className="whats-new-item-title">{entry.title}</span>
                      <span className="whats-new-item-date">{formatDate(entry.date)}</span>
                    </div>
                    <span className="whats-new-item-desc">{entry.desc}</span>
                  </div>
                  {entry.details && (
                    <span className={`whats-new-expand-icon${open ? " whats-new-expand-icon--open" : ""}`}>▼</span>
                  )}
                </div>
                {open && entry.details && (
                  <div className="whats-new-item-details">{entry.details}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
