import { ShieldCheck, Cpu, Database, Terminal } from "lucide-react";
import { useResource } from "../api.ts";
import { ErrorNotice, PageHeader } from "../components.tsx";

type SettingsData = {
  backend: { id: string; available: boolean; reason?: string };
  execution: string;
  storage: string;
};
export function Settings() {
  const { data, error } = useResource<SettingsData>("/settings");
  return (
    <div className="page narrow">
      <PageHeader
        eyebrow="LOCAL BY DESIGN"
        title="Workspace settings"
        description="Connection authority stays on your machine, not in a workflow."
      />
      <ErrorNotice error={error} />
      <div className="settings-panel">
        <div>
          <Cpu size={20} />
          <section>
            <h3>Agent backend</h3>
            <p>
              {data?.backend.id || "Checking…"} ·{" "}
              {data?.backend.available ? "Available" : "Not available"}
            </p>
            <ErrorNotice error={data?.backend.reason} />
            <code>COPILOT_BIN=/path/to/copilot</code>
            <p>
              Uses your authenticated Copilot CLI. Models are configurable per
              agent.
            </p>
          </section>
        </div>
        <div>
          <ShieldCheck size={20} />
          <section>
            <h3>Execution scope</h3>
            <p>{data?.execution}</p>
            <p>
              Tool policies are not an operating-system sandbox. Use only
              trusted workflows.
            </p>
          </section>
        </div>
        <div>
          <Database size={20} />
          <section>
            <h3>Run storage</h3>
            <p>{data?.storage}</p>
            <code>PLATFORM_DATA_DIR=/your/workspace/data</code>
          </section>
        </div>
        <div>
          <Terminal size={20} />
          <section>
            <h3>Azure DevOps watcher</h3>
            <p>
              Configure <code>ADO_PAT</code> in the host environment for PR-head
              detection. Credentials never enter workflow files or browser
              responses.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
