import type { GuardCondition, GuardExpression } from '@alphred/shared';
import { evaluateGuard } from '../guards.js';
import { guardOperators } from './constants.js';
import { isRecord } from './type-conversions.js';
import type { EdgeRow, RoutingDecisionType } from './types.js';

export function readRoutingDecisionAttempt(rawOutput: unknown): number | null {
  if (!isRecord(rawOutput)) {
    return null;
  }

  const attempt = rawOutput.attempt;
  return typeof attempt === 'number' && Number.isInteger(attempt) && attempt > 0 ? attempt : null;
}

export function isGuardExpression(value: unknown): value is GuardExpression {
  if (!isRecord(value)) {
    return false;
  }

  if ('logic' in value) {
    if ((value.logic !== 'and' && value.logic !== 'or') || !Array.isArray(value.conditions)) {
      return false;
    }

    return value.conditions.every(isGuardExpression);
  }

  if (!('field' in value) || !('operator' in value) || !('value' in value)) {
    return false;
  }

  if (typeof value.field !== 'string') {
    return false;
  }

  if (!guardOperators.has(value.operator as GuardCondition['operator'])) {
    return false;
  }

  return ['string', 'number', 'boolean'].includes(typeof value.value);
}

export function doesEdgeMatchDecision(edge: EdgeRow, decisionType: RoutingDecisionType | null): boolean {
  if (edge.auto === 1) {
    return true;
  }

  // Guarded routes require a concrete structured decision signal.
  if (decisionType === null || decisionType === 'no_route') {
    return false;
  }

  if (!isGuardExpression(edge.guardExpression)) {
    throw new Error(`Invalid guard expression for tree edge id=${edge.edgeId}.`);
  }

  return evaluateGuard(edge.guardExpression, { decision: decisionType });
}

export function selectFirstMatchingOutgoingEdge(
  outgoingEdges: EdgeRow[],
  decisionType: RoutingDecisionType | null,
): EdgeRow | null {
  for (const edge of outgoingEdges) {
    if (doesEdgeMatchDecision(edge, decisionType)) {
      return edge;
    }
  }

  return null;
}
