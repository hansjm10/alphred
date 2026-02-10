import type { GuardExpression, GuardCondition } from '@alphred/shared';

function resolveField(context: Record<string, unknown>, field: string): unknown {
  const parts = field.split('.');
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evaluateCondition(condition: GuardCondition, context: Record<string, unknown>): boolean {
  const fieldValue = resolveField(context, condition.field);
  const target = condition.value;

  switch (condition.operator) {
    case '==': return fieldValue === target;
    case '!=': return fieldValue !== target;
    case '>': return typeof fieldValue === 'number' && typeof target === 'number' && fieldValue > target;
    case '<': return typeof fieldValue === 'number' && typeof target === 'number' && fieldValue < target;
    case '>=': return typeof fieldValue === 'number' && typeof target === 'number' && fieldValue >= target;
    case '<=': return typeof fieldValue === 'number' && typeof target === 'number' && fieldValue <= target;
  }
}

export function evaluateGuard(guard: GuardExpression, context: Record<string, unknown>): boolean {
  if ('logic' in guard) {
    const results = guard.conditions.map(c => evaluateGuard(c, context));
    return guard.logic === 'and'
      ? results.every(Boolean)
      : results.some(Boolean);
  }
  return evaluateCondition(guard, context);
}
