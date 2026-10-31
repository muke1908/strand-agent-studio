import { useState } from "react";
import { BookOpen, Plus, X } from "lucide-react";
import { skillSchema } from "../../shared/contracts.ts";
import type { Saved, Skill } from "../../shared/contracts.ts";
import { api, errorMessage, useResource } from "../api.ts";
import { ErrorNotice, Loading, PageHeader } from "../components.tsx";

export function Skills() {
  const resource = useResource<Saved<Skill>[]>("/skills");
  const [selected, setSelected] = useState<Saved<Skill>>();
  const [draft, setDraft] = useState<Skill>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const value = skillSchema.parse(draft);
      await api(`/skills/${value.id}`, {
        method: "PUT",
        body: JSON.stringify({ value, revision: selected?.revision }),
      });
      setDraft(undefined);
      setSelected(undefined);
      setError("");
      resource.reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <PageHeader
        eyebrow="REUSABLE KNOW-HOW"
        title="Skills"
        description="Good instructions deserve to be used more than once."
      >
        <button
          className="button primary"
          onClick={() => {
            setSelected(undefined);
            setDraft({
              id: `skill-${crypto.randomUUID().slice(0, 8)}`,
              name: "",
              description: "",
              instructions: "",
            });
          }}
        >
          <Plus size={16} />
          New skill
        </button>
      </PageHeader>
      <ErrorNotice error={resource.error || error} />
      {!resource.data ? (
        <Loading />
      ) : (
        <div className="list-panel">
          {resource.data.map((item) => (
            <button
              key={item.value.id}
              className="list-row skill-row"
              onClick={() => {
                setSelected(item);
                setDraft(item.value);
              }}
            >
              <span className="workflow-icon">
                <BookOpen size={18} />
              </span>
              <div>
                <strong>{item.value.name}</strong>
                <span>{item.value.description}</span>
              </div>
              <span className="muted">Edit instructions →</span>
            </button>
          ))}
        </div>
      )}
      {draft && (
        <div className="modal-backdrop">
          <form className="modal-panel" onSubmit={(event) => void save(event)}>
            <div className="inspector-heading">
              <h2>{selected ? "Edit skill" : "New skill"}</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close skill editor"
                onClick={() => setDraft(undefined)}
              >
                <X size={18} />
              </button>
            </div>
            <label className="field">
              Skill name
              <input
                required
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <label className="field">
              Description
              <input
                value={draft.description}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
              />
            </label>
            <label className="field">
              Import Markdown
              <input
                type="file"
                accept=".md,.markdown,text/markdown"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 50000) {
                    setError("Markdown must be under 50 KB.");
                    return;
                  }
                  void file
                    .text()
                    .then((instructions) => {
                      setDraft({ ...draft, instructions });
                      setError("");
                    })
                    .catch((failure) => setError(errorMessage(failure)));
                }}
              />
            </label>
            <label className="field">
              Markdown instructions
              <textarea
                className="code"
                rows={12}
                required
                value={draft.instructions}
                onChange={(event) =>
                  setDraft({ ...draft, instructions: event.target.value })
                }
              />
            </label>
            <ErrorNotice error={error} />
            <div className="form-footer">
              <span>Procedure, not permissions.</span>
              <button className="button primary" disabled={busy}>
                Save skill
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
