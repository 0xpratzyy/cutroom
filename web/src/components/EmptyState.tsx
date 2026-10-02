import { useState } from "react";
import { api } from "../api";
import { useStore, toast } from "../store";
import { Icon } from "./Icon";

const MCP_CMD = "claude mcp add cutroom -- npx -y cutroom mcp";

export function EmptyState() {
  const hasMedia = useStore((s) => (s.project?.media.length ?? 0) > 0);
  const [path, setPath] = useState("");
  const [copied, setCopied] = useState(false);
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name="upload" size={22} />
      </div>
      <h2>{hasMedia ? "Your timeline is empty" : "Drop in a recording"}</h2>
      <p style={{ margin: 0 }}>
        {hasMedia ? "Drag something from the Media tab onto the Main track." : "Drag a video anywhere onto this window. It's transcribed on your machine so you can edit it like a doc."}
      </p>
      <form
        className="import-row"
        onSubmit={(e) => {
          e.preventDefault();
          const p = path.trim().replace(/^['"]|['"]$/g, "");
          if (!p) return;
          void api.importPaths([p]).then((r) => r && toast("Imported. Transcribing in the background…"));
          setPath("");
        }}
      >
        <input placeholder="…or paste a file path" value={path} onChange={(e) => setPath(e.target.value)} />
        <button type="submit" className="primary" disabled={!path.trim()}>
          Import
        </button>
      </form>
      <div className="agent-card">
        <div className="agent-card-head">
          <Icon name="sparkle" size={13} /> Or let an agent edit it
        </div>
        <div className="cmd">
          <code>{MCP_CMD}</code>
          <button
            className="ghost sm"
            onClick={() => {
              void navigator.clipboard?.writeText(MCP_CMD);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
