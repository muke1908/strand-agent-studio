import { useState } from "react";

export function AgentFolders({
  folders,
  onChange,
}: {
  folders: string[];
  onChange: (folders: string[]) => void;
}) {
  const [draft, setDraft] = useState(() => folders.join("\n"));
  return (
    <label className="field">
      Allowed folders
      <textarea
        className="code"
        value={draft}
        rows={3}
        placeholder="/absolute/path/to/project"
        aria-describedby="agent-folder-help"
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(
            event.target.value
              .split(/\r?\n/)
              .map((folder) => folder.trim())
              .filter(Boolean),
          );
        }}
      />
      <small id="agent-folder-help">
        Optional. One existing absolute directory per line. Only this agent gets
        these read/write grants. Use trusted folders; their .github skills and
        agents may be loaded. Environment permissions still apply.
      </small>
    </label>
  );
}
