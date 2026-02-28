"use client";

import "./progress-step.css";

export type StepStatus = "pending" | "running" | "success" | "failed";

interface ProgressStepProps {
  name: string;
  status: StepStatus;
  result?: string;
  error?: string;
}

const statusIcons: Record<StepStatus, React.ReactNode> = {
  pending: <span className="progress-step__icon--pending" />,
  running: <span className="progress-step__icon--running" />,
  success: (
    <span className="progress-step__icon--success">&#10003;</span>
  ),
  failed: (
    <span className="progress-step__icon--failed">&#10007;</span>
  ),
};

const nameClasses: Record<StepStatus, string> = {
  pending: "progress-step__name",
  running: "progress-step__name progress-step__name--running",
  success: "progress-step__name",
  failed: "progress-step__name progress-step__name--failed",
};

export function ProgressStep({ name, status, result, error }: ProgressStepProps) {
  return (
    <div className="progress-step">
      <div className="progress-step__icon">{statusIcons[status]}</div>
      <div className="progress-step__body">
        <p className={nameClasses[status]}>{name}</p>
        {result && <p className="progress-step__result">{result}</p>}
        {error && <p className="progress-step__error">{error}</p>}
      </div>
    </div>
  );
}
