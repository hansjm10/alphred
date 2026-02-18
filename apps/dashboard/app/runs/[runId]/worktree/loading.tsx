import { Card } from '../../../ui/primitives';

export default function RunWorktreeLoading() {
  return (
    <div className="page-stack">
      <Card title="Loading worktree">
        <output aria-live="polite">Preparing changed-file explorer...</output>
      </Card>
    </div>
  );
}

