import { useEffect, useRef, useState } from "react";
import { FileText, Folder, X } from "lucide-react";
import type { Agent, InstructionDirectory } from "../../shared/contracts.ts";
import { api, errorMessage } from "../api.ts";
import { ErrorNotice, Loading } from "../components.tsx";

export function AgentInstructions({
  agent,
  onChange,
}: {
  agent: Agent;
  onChange: (agent: Agent) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  function choose(file: string) {
    onChange({
      ...agent,
      instructionsFile: file || undefined,
      instructions: "",
    });
    setChoosing(false);
  }
  return (
    <>
      <div className="field">
        <span>Agent instructions file</span>
        <div className="instruction-file-row">
          <FileText size={16} aria-hidden="true" />
          <output
            className={`instruction-file-name${agent.instructionsFile ? "" : " muted"}`}
            aria-label="Agent instructions file"
            title={agent.instructionsFile}
            aria-describedby="instruction-file-help"
          >
            {agent.instructionsFile?.split(/[/\\]/).at(-1) ||
              "No file selected"}
          </output>
          <button
            className="icon-button"
            type="button"
            aria-label="Choose Markdown file"
            title="Choose Markdown file"
            onClick={() => setChoosing(true)}
          >
            <Folder size={16} aria-hidden="true" />
          </button>
        </div>
        <small id="instruction-file-help">
          Reads the Markdown file for each new run. Existing runs and reruns
          keep their pinned copy.
        </small>
      </div>
      {!agent.instructionsFile && agent.instructions && (
        <p className="muted">
          Uses previously saved inline instructions. Select a Markdown file to
          replace them.
        </p>
      )}
      {choosing && (
        <InstructionPicker
          initialDirectory={
            agent.instructionsFile?.slice(
              0,
              agent.instructionsFile.lastIndexOf("/"),
            ) || undefined
          }
          onSelect={choose}
          onClose={() => setChoosing(false)}
        />
      )}
    </>
  );
}

function InstructionPicker({
  initialDirectory,
  onSelect,
  onClose,
}: {
  initialDirectory?: string;
  onSelect: (file: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [directory, setDirectory] = useState(initialDirectory);
  const [draft, setDraft] = useState(initialDirectory ?? "");
  const [listing, setListing] = useState<InstructionDirectory>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setListing(undefined);
    void api<InstructionDirectory>(
      `/instruction-files${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setListing(value);
        setDraft(value.directory);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [directory]);
  return (
    <dialog
      ref={dialog}
      className="modal-panel instruction-picker"
      aria-labelledby="instruction-picker-title"
      onClose={(event) => {
        if (!event.currentTarget.open) onClose();
      }}
      onCancel={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="inspector-heading">
        <h2 id="instruction-picker-title">Choose Markdown file</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close file picker"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <form
        className="instruction-directory"
        onSubmit={(event) => {
          event.preventDefault();
          setDirectory(draft);
        }}
      >
        <label className="field">
          Directory
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button className="button" type="submit">
          Open directory
        </button>
      </form>
      <ErrorNotice error={error} />
      {loading && <Loading />}
      {listing && (
        <>
          <button
            type="button"
            className="button"
            disabled={!listing.parent}
            onClick={() => {
              if (listing.parent) setDirectory(listing.parent);
            }}
          >
            Parent directory
          </button>
          <ul
            className="instruction-file-list"
            aria-label="Directories and Markdown files"
          >
            {listing.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    entry.kind === "directory"
                      ? setDirectory(entry.path)
                      : onSelect(entry.path)
                  }
                >
                  {entry.kind === "directory" ? (
                    <Folder size={16} />
                  ) : (
                    <FileText size={16} />
                  )}
                  {entry.name}
                  {entry.kind === "directory" ? "/" : ""}
                </button>
              </li>
            ))}
          </ul>
          {!listing.entries.length && (
            <p className="muted">No directories or Markdown files.</p>
          )}
        </>
      )}
    </dialog>
  );
}
