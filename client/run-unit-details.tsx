import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { UnitDetails } from "../shared/contracts.ts";
import { useResource } from "./api.ts";
import { ErrorNotice, Loading, StatusBadge } from "./components.tsx";

export function RunUnitDetails({
  runId,
  unitKey,
  name,
  onClose,
}: {
  runId: string;
  unitKey: string;
  name: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const resource = useResource<UnitDetails>(
    `/pipeline-runs/${runId}/activity?unit=${encodeURIComponent(unitKey)}`,
    true,
  );
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const details = resource.data;
  return (
    <dialog
      ref={dialog}
      className="modal-panel unit-details"
      aria-labelledby="activity-title"
      onClose={(event) => {
        // StrictMode cleanup can queue a close event before reopening the dialog.
        if (!event.currentTarget.open) onClose();
      }}
    >
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">ACTIVITY DETAILS</span>
          <h2 id="activity-title">{name}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close activity details"
          onClick={() => dialog.current?.close()}
        >
          <X size={16} />
        </button>
      </div>
      <ErrorNotice
        error={resource.error || details?.unit.attempts.at(-1)?.error}
      />
      {!details ? (
        !resource.error && <Loading />
      ) : (
        <>
          <StatusBadge status={details.unit.status} />
          <p className="muted">
            {details.kind === "contract"
              ? "Authored schema in, validated expanded schema out."
              : "Pinned stage and agent instructions, Markdown skills, workflow input, stage bindings and earlier-stage handoffs."}
          </p>
          <div className="run-layout">
            <section aria-labelledby="activity-input">
              <div className="section-heading">
                <h3 id="activity-input">Input</h3>
              </div>
              <pre className="result-panel">
                {JSON.stringify(details.input, null, 2)}
              </pre>
            </section>
            <section aria-labelledby="activity-output">
              <div className="section-heading">
                <h3 id="activity-output">Output</h3>
              </div>
              <pre className="result-panel">
                {details.output === undefined
                  ? "No accepted output yet."
                  : JSON.stringify(details.output, null, 2)}
              </pre>
            </section>
          </div>
        </>
      )}
    </dialog>
  );
}
