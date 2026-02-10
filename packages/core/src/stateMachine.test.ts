import { describe, it, expect } from 'vitest';
import {
  canTransitionRun,
  canTransitionPhase,
  transitionRun,
  transitionPhase,
  isRunTerminal,
  isPhaseTerminal,
} from './stateMachine.js';

describe('stateMachine', () => {
  describe('run transitions', () => {
    it('should allow pending -> running', () => {
      expect(canTransitionRun('pending', 'running')).toBe(true);
    });

    it('should allow running -> completed', () => {
      expect(canTransitionRun('running', 'completed')).toBe(true);
    });

    it('should allow running -> paused', () => {
      expect(canTransitionRun('running', 'paused')).toBe(true);
    });

    it('should allow paused -> running', () => {
      expect(canTransitionRun('paused', 'running')).toBe(true);
    });

    it('should not allow completed -> running', () => {
      expect(canTransitionRun('completed', 'running')).toBe(false);
    });

    it('should throw on invalid transition', () => {
      expect(() => transitionRun('completed', 'running')).toThrow('Invalid run transition');
    });

    it('should return new status on valid transition', () => {
      expect(transitionRun('pending', 'running')).toBe('running');
    });
  });

  describe('phase transitions', () => {
    it('should allow pending -> running', () => {
      expect(canTransitionPhase('pending', 'running')).toBe(true);
    });

    it('should allow pending -> skipped', () => {
      expect(canTransitionPhase('pending', 'skipped')).toBe(true);
    });

    it('should allow failed -> running (retry)', () => {
      expect(canTransitionPhase('failed', 'running')).toBe(true);
    });

    it('should not allow completed -> running', () => {
      expect(canTransitionPhase('completed', 'running')).toBe(false);
    });

    it('should throw on invalid transition', () => {
      expect(() => transitionPhase('completed', 'running')).toThrow('Invalid phase transition');
    });
  });

  describe('terminal states', () => {
    it('should identify terminal run states', () => {
      expect(isRunTerminal('completed')).toBe(true);
      expect(isRunTerminal('failed')).toBe(true);
      expect(isRunTerminal('cancelled')).toBe(true);
      expect(isRunTerminal('running')).toBe(false);
    });

    it('should identify terminal phase states', () => {
      expect(isPhaseTerminal('completed')).toBe(true);
      expect(isPhaseTerminal('skipped')).toBe(true);
      expect(isPhaseTerminal('failed')).toBe(false);
    });
  });
});
