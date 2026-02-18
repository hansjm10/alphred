import type { GitHubAuthGate } from './github-auth';

type AuthRemediationProps = Readonly<{
  authGate: GitHubAuthGate;
  context: string;
}>;

export function AuthRemediation({ authGate, context }: AuthRemediationProps) {
  if (!authGate.needsRemediation) {
    return null;
  }

  return (
    <section className="status-panel" aria-live="polite">
      <p>{context}</p>
      <p className="meta-text">{authGate.detail}</p>
      <p className="meta-text">Remediation</p>
      <div className="page-stack">
        {authGate.remediationCommands.map(command => (
          <code key={command} className="code-preview">
            {command}
          </code>
        ))}
      </div>
    </section>
  );
}
