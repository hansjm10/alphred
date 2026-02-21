'use client';

import { useState } from 'react';
import { ActionButton } from '../ui/primitives';

type CopyState = 'idle' | 'copied' | 'error';

async function copyToClipboard(value: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!ok) {
    throw new Error('Copy failed');
  }
}

export function WorkflowJsonCopyActions({ json }: Readonly<{ json: string }>) {
  const [state, setState] = useState<CopyState>('idle');

  async function handleCopy() {
    setState('idle');
    try {
      await copyToClipboard(json);
      setState('copied');
      window.setTimeout(() => setState('idle'), 1600);
    } catch {
      setState('error');
    }
  }

  return (
    <div className="workflow-json-actions">
      <ActionButton onClick={handleCopy}>Copy JSON</ActionButton>
      <span className="meta-text" role="status" aria-live="polite">
        {state === 'copied' ? 'Copied.' : state === 'error' ? 'Copy failed.' : ''}
      </span>
    </div>
  );
}

