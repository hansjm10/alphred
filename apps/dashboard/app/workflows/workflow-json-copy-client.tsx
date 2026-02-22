'use client';

import { useState } from 'react';
import { ActionButton } from '../ui/primitives';

type CopyState = 'idle' | 'copied' | 'error';

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  throw new Error('Copy is unavailable in this browser. Select the JSON and copy manually.');
}

export function WorkflowJsonCopyActions({ json }: Readonly<{ json: string }>) {
  const [state, setState] = useState<CopyState>('idle');

  let statusText = '';
  if (state === 'copied') {
    statusText = 'Copied.';
  } else if (state === 'error') {
    statusText = 'Copy failed.';
  }

  async function handleCopy() {
    setState('idle');
    try {
      await copyToClipboard(json);
      setState('copied');
      globalThis.setTimeout(() => setState('idle'), 1600);
    } catch {
      setState('error');
    }
  }

  return (
    <div className="workflow-json-actions">
      <ActionButton onClick={handleCopy}>Copy JSON</ActionButton>
      <output className="meta-text" aria-live="polite">{statusText}</output>
    </div>
  );
}
