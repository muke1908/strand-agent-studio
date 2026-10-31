import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import type { Schema, Status } from "../shared/contracts.ts";

export function ErrorNotice({ error }: { error?: string }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div className="loading">
      <Loader2 size={16} className="spin" /> Loading
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="header-actions">{children}</div>
    </header>
  );
}
export function StatusBadge({ status }: { status: Status | string }) {
  return (
    <span className={`status status-${status}`}>
      <i />
      {status}
    </span>
  );
}
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <ArrowUpRight size={22} />
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function JsonEditor({
  label,
  value,
  onChange,
  onError,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  onError: (error: string) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const committed = useRef(JSON.stringify(value));
  useEffect(() => {
    const serialized = JSON.stringify(value);
    if (serialized !== committed.current) {
      setText(JSON.stringify(value, null, 2));
      committed.current = serialized;
    }
  }, [value]);
  return (
    <label className="field">
      {label}
      <textarea
        className="code"
        rows={9}
        value={text}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          try {
            const parsed: unknown = JSON.parse(event.target.value);
            onChange(parsed);
            committed.current = JSON.stringify(parsed);
            onError("");
          } catch (error) {
            onError(error instanceof Error ? error.message : String(error));
          }
        }}
      />
    </label>
  );
}
export function schemaFields(schema: Schema): [string, Schema][] {
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return [];
  return Object.entries(properties).flatMap(([key, value]) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? [[key, value]]
      : [],
  );
}
