import type { Stage } from "../../shared/contracts.ts";

export function ExpectedOutput({
  stage,
  onChange,
}: {
  stage: Stage;
  onChange: (stage: Stage) => void;
}) {
  return (
    <label className="field">
      Expected output
      <textarea
        rows={5}
        maxLength={50000}
        placeholder="For example: Return a short implementation plan with the files to change and tests to run."
        value={stage.expectedOutput ?? ""}
        onChange={(event) =>
          onChange({
            ...stage,
            expectedOutput: event.target.value,
            inputs: {},
            ...(stage.loop ? { loop: { ...stage.loop, feedback: {} } } : {}),
          })
        }
      />
      <small>
        Describe the result in plain language. The complete result is passed to
        the next stage automatically.
        {stage.expectedOutput === undefined &&
          " This saved stage keeps its existing contract until you edit this field."}
      </small>
    </label>
  );
}
