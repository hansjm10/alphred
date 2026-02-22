import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Edge, Node } from '@xyflow/react';
import type {
  DashboardSaveWorkflowDraftRequest,
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
} from '../../../../src/server/dashboard-contracts';
import { resolveApiError } from '../../workflows-shared';

export type SaveState = 'draft' | 'saving' | 'saved' | 'error';

export type WorkflowSnapshot = Readonly<{
  name: string;
  description: string;
  versionNotes: string;
  nodes: Node[];
  edges: Edge[];
}>;

type DraftSaveState = {
  draftRevision: number;
  name: string;
  description: string;
  versionNotes: string;
  nodes: DashboardWorkflowDraftNode[];
  edges: DashboardWorkflowDraftEdge[];
};

export function useDraftAutosave(args: Readonly<{
  treeKey: string;
  version: number;
  latestDraftStateRef: MutableRefObject<DraftSaveState>;
}>) {
  const [saveState, setSaveState] = useState<SaveState>('draft');
  const [saveError, setSaveError] = useState<string | null>(null);
  const pendingSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightSaveAbortRef = useRef<AbortController | null>(null);
  const inFlightSavePromiseRef = useRef<Promise<boolean> | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const markDirty = useCallback(() => {
    setSaveState('draft');
  }, []);

  const saveNow = useCallback((): Promise<boolean> => {
    if (pendingSaveRef.current !== null) {
      globalThis.clearTimeout(pendingSaveRef.current);
      pendingSaveRef.current = null;
    }

    const runSave = async (): Promise<boolean> => {
      setSaveError(null);
      setSaveState('saving');

      const snapshot = args.latestDraftStateRef.current;
      const previousDraftRevision = snapshot.draftRevision;
      const nextDraftRevision = previousDraftRevision + 1;
      args.latestDraftStateRef.current = { ...snapshot, draftRevision: nextDraftRevision };

      const payload: DashboardSaveWorkflowDraftRequest = {
        draftRevision: nextDraftRevision,
        name: snapshot.name,
        description: snapshot.description.trim().length > 0 ? snapshot.description : undefined,
        versionNotes: snapshot.versionNotes.trim().length > 0 ? snapshot.versionNotes : undefined,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
      };

      const abortController = new AbortController();
      inFlightSaveAbortRef.current = abortController;

      const rollbackDraftRevision = () => {
        if (args.latestDraftStateRef.current.draftRevision === nextDraftRevision) {
          args.latestDraftStateRef.current = { ...args.latestDraftStateRef.current, draftRevision: previousDraftRevision };
        }
      };

      try {
        const response = await fetch(`/api/dashboard/workflows/${encodeURIComponent(args.treeKey)}/draft?version=${args.version}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: abortController.signal,
        });

        const json = await response.json().catch(() => null);
        if (!response.ok) {
          rollbackDraftRevision();
          setSaveState('error');
          setSaveError(resolveApiError(response.status, json, 'Autosave failed'));
          return false;
        }

        if (json && typeof json === 'object' && 'draft' in json) {
          const draftRevision = (json as { draft?: { draftRevision?: unknown } }).draft?.draftRevision;
          if (
            typeof draftRevision === 'number' &&
            Number.isInteger(draftRevision) &&
            draftRevision > args.latestDraftStateRef.current.draftRevision
          ) {
            args.latestDraftStateRef.current = { ...args.latestDraftStateRef.current, draftRevision };
          }
        }

        setSaveState('saved');
        return true;
      } catch (error_) {
        if (error_ instanceof DOMException && error_.name === 'AbortError') {
          rollbackDraftRevision();
          return false;
        }
        rollbackDraftRevision();
        setSaveState('error');
        setSaveError(error_ instanceof Error ? error_.message : 'Autosave failed.');
        return false;
      } finally {
        if (inFlightSaveAbortRef.current === abortController) {
          inFlightSaveAbortRef.current = null;
        }
      }
    };

    const savePromise = saveQueueRef.current.then(runSave, runSave);
    saveQueueRef.current = savePromise.then(() => undefined, () => undefined);
    inFlightSavePromiseRef.current = savePromise;
    return savePromise.finally(() => {
      if (inFlightSavePromiseRef.current === savePromise) {
        inFlightSavePromiseRef.current = null;
      }
    });
  }, [args.latestDraftStateRef, args.treeKey, args.version]);

  const scheduleSave = useCallback(() => {
    if (pendingSaveRef.current !== null) {
      globalThis.clearTimeout(pendingSaveRef.current);
    }

    pendingSaveRef.current = globalThis.setTimeout(() => {
      pendingSaveRef.current = null;
      saveNow().catch(() => undefined);
    }, 1000);
  }, [saveNow]);

  const flushSave = useCallback(async (): Promise<boolean> => {
    if (pendingSaveRef.current !== null) {
      return saveNow();
    }

    if (inFlightSavePromiseRef.current) {
      return inFlightSavePromiseRef.current;
    }

    if (saveState === 'saved') {
      return true;
    }

    return saveNow();
  }, [saveNow, saveState]);

  useEffect(() => {
    return () => {
      if (pendingSaveRef.current !== null) {
        globalThis.clearTimeout(pendingSaveRef.current);
      }
      if (inFlightSaveAbortRef.current) {
        inFlightSaveAbortRef.current.abort();
        inFlightSaveAbortRef.current = null;
      }
    };
  }, []);

  return useMemo(() => {
    return {
      markDirty,
      flushSave,
      saveError,
      saveNow,
      saveState,
      scheduleSave,
      setSaveError,
    };
  }, [flushSave, markDirty, saveError, saveNow, saveState, scheduleSave]);
}

export function useWorkflowHistory(args: Readonly<{
  snapshot: WorkflowSnapshot;
  applySnapshot: (snapshot: WorkflowSnapshot) => void;
  markDirty: () => void;
  scheduleSave: () => void;
}>) {
  const { applySnapshot, markDirty, scheduleSave } = args;
  const historyRef = useRef<{
    past: WorkflowSnapshot[];
    present: WorkflowSnapshot;
    future: WorkflowSnapshot[];
  }>({
    past: [],
    present: args.snapshot,
    future: [],
  });

  const applyingHistoryRef = useRef(false);
  const latestSnapshotRef = useRef<WorkflowSnapshot>(args.snapshot);
  const pendingHistoryCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestSnapshotRef.current = args.snapshot;
  }, [args.snapshot]);

  const commitLatestSnapshot = useCallback(() => {
    const history = historyRef.current;
    const snapshot = latestSnapshotRef.current;
    history.past = [...history.past, history.present].slice(-50);
    history.present = snapshot;
    history.future = [];
  }, []);

  const scheduleHistoryCommit = useCallback(() => {
    if (applyingHistoryRef.current) {
      return;
    }

    if (pendingHistoryCommitRef.current !== null) {
      globalThis.clearTimeout(pendingHistoryCommitRef.current);
    }

    pendingHistoryCommitRef.current = globalThis.setTimeout(() => {
      pendingHistoryCommitRef.current = null;
      commitLatestSnapshot();
    }, 400);
  }, [commitLatestSnapshot]);

  const flushPendingHistoryCommit = useCallback(() => {
    if (pendingHistoryCommitRef.current === null) {
      return;
    }

    globalThis.clearTimeout(pendingHistoryCommitRef.current);
    pendingHistoryCommitRef.current = null;
    commitLatestSnapshot();
  }, [commitLatestSnapshot]);

  const undo = useCallback(() => {
    flushPendingHistoryCommit();

    const history = historyRef.current;
    if (history.past.length === 0) {
      return;
    }

    const previous = history.past[history.past.length - 1];
    const remaining = history.past.slice(0, -1);
    history.past = remaining;
    history.future = [history.present, ...history.future];
    history.present = previous;

    applyingHistoryRef.current = true;
    applySnapshot(previous);
    markDirty();
    scheduleSave();
    globalThis.setTimeout(() => {
      applyingHistoryRef.current = false;
    }, 0);
  }, [applySnapshot, flushPendingHistoryCommit, markDirty, scheduleSave]);

  const redo = useCallback(() => {
    flushPendingHistoryCommit();

    const history = historyRef.current;
    if (history.future.length === 0) {
      return;
    }

    const next = history.future[0];
    history.future = history.future.slice(1);
    history.past = [...history.past, history.present].slice(-50);
    history.present = next;

    applyingHistoryRef.current = true;
    applySnapshot(next);
    markDirty();
    scheduleSave();
    globalThis.setTimeout(() => {
      applyingHistoryRef.current = false;
    }, 0);
  }, [applySnapshot, flushPendingHistoryCommit, markDirty, scheduleSave]);

  useEffect(() => {
    return () => {
      if (pendingHistoryCommitRef.current !== null) {
        globalThis.clearTimeout(pendingHistoryCommitRef.current);
      }
    };
  }, []);

  return useMemo(() => {
    return { redo, scheduleHistoryCommit, undo };
  }, [redo, scheduleHistoryCommit, undo]);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) {
    return false;
  }

  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function useWorkflowKeyboardShortcuts(args: Readonly<{
  addNodePaletteOpenRef: MutableRefObject<boolean>;
  selectedNodeIdRef: MutableRefObject<string | null>;
  selectedEdgeIdRef: MutableRefObject<string | null>;
  edgesRef: MutableRefObject<Edge[]>;
  closePalette: () => void;
  openPalette: () => void;
  undo: () => void;
  redo: () => void;
  deleteEdgeById: (edgeId: string) => void;
  deleteNodeById: (nodeId: string) => void;
}>) {
  const {
    addNodePaletteOpenRef,
    selectedNodeIdRef,
    selectedEdgeIdRef,
    edgesRef,
    closePalette,
    openPalette,
    undo,
    redo,
    deleteEdgeById,
    deleteNodeById,
  } = args;

  useEffect(() => {
    function handlePaletteShortcuts(event: KeyboardEvent): boolean {
      if (!addNodePaletteOpenRef.current) {
        return false;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closePalette();
      }

      return true;
    }

    function handleUndoRedoShortcuts(event: KeyboardEvent, key: string): boolean {
      const hasModifier = event.metaKey || event.ctrlKey;
      if (!hasModifier) return false;

      const isUndo = key === 'z' && !event.shiftKey;
      if (isUndo) {
        event.preventDefault();
        undo();
        return true;
      }

      const isRedo = (key === 'z' && event.shiftKey) || key === 'y';
      if (isRedo) {
        event.preventDefault();
        redo();
        return true;
      }

      return false;
    }

    function handleDeleteShortcuts(event: KeyboardEvent): boolean {
      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return false;
      }

      const selectedEdgeId = selectedEdgeIdRef.current;
      if (selectedEdgeId) {
        event.preventDefault();
        deleteEdgeById(selectedEdgeId);
        return true;
      }

      const selectedNodeId = selectedNodeIdRef.current;
      if (!selectedNodeId) {
        return false;
      }

      event.preventDefault();
      const connectedEdgeCount = edgesRef.current.reduce((count, edge) => {
        return count + (edge.source === selectedNodeId || edge.target === selectedNodeId ? 1 : 0);
      }, 0);

      if (
        connectedEdgeCount > 0 &&
        !globalThis.confirm('Delete this node and its connected transitions?')
      ) {
        return true;
      }

      deleteNodeById(selectedNodeId);
      return true;
    }

    function handleOpenPaletteShortcut(event: KeyboardEvent, key: string): boolean {
      if (event.metaKey || event.ctrlKey) {
        return false;
      }

      if (key !== 'n') {
        return false;
      }

      event.preventDefault();
      openPalette();
      return true;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (handlePaletteShortcuts(event)) {
        return;
      }

      if (handleUndoRedoShortcuts(event, key)) return;
      if (handleDeleteShortcuts(event)) return;
      handleOpenPaletteShortcut(event, key);
    }

    globalThis.addEventListener('keydown', handleKeyDown);
    return () => globalThis.removeEventListener('keydown', handleKeyDown);
  }, [
    addNodePaletteOpenRef,
    closePalette,
    deleteEdgeById,
    deleteNodeById,
    edgesRef,
    openPalette,
    redo,
    selectedEdgeIdRef,
    selectedNodeIdRef,
    undo,
  ]);
}
