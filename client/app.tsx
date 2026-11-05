import { NavLink, Route, Routes } from "react-router-dom";
import {
  Blocks,
  GitBranch,
  LayoutGrid,
  Radio,
  Sparkles,
  Settings2,
  BookOpen,
  PanelsTopLeft,
  ListOrdered,
} from "lucide-react";
import { Overview } from "./pages/overview.tsx";
import { Workflows } from "./pages/workflows.tsx";
import { WorkflowBuilder } from "./builder/workflow-builder.tsx";
import { Launch } from "./pages/launch.tsx";
import { Runs, RunDetail } from "./pages/runs.tsx";
import { Skills } from "./pages/skills.tsx";
import { Watches } from "./pages/watches.tsx";
import { Settings } from "./pages/settings.tsx";
import { WatchDashboard } from "./pages/watch-dashboard.tsx";
import { Queue } from "./pages/queue.tsx";

const links = [
  { to: "/", label: "Overview", icon: LayoutGrid },
  { to: "/pipelines", label: "Workflows", icon: GitBranch },
  { to: "/skills", label: "Skills", icon: BookOpen },
  { to: "/runs", label: "Runs", icon: Blocks },
  { to: "/queue", label: "Queue", icon: ListOrdered },
  { to: "/watches", label: "Watches", icon: Radio },
  { to: "/dashboard", label: "Dashboard", icon: PanelsTopLeft },
  { to: "/settings", label: "Settings", icon: Settings2 },
];
export function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand">
          <span className="brand-mark">
            <Sparkles size={18} />
          </span>
          strand<span className="brand-tag">studio</span>
        </NavLink>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"}>
              <Icon size={17} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="local-dot" />
          Local workspace<span>Agent-first. Yours to compose.</span>
        </div>
      </aside>
      <main>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/pipelines" element={<Workflows />} />
          <Route path="/pipelines/new" element={<WorkflowBuilder />} />
          <Route path="/pipelines/:id" element={<WorkflowBuilder />} />
          <Route path="/pipelines/:id/run" element={<Launch />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/watches" element={<Watches />} />
          <Route path="/dashboard" element={<WatchDashboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route
            path="*"
            element={
              <div className="empty">
                <h1>Page not found</h1>
                <NavLink to="/">Back to overview</NavLink>
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
