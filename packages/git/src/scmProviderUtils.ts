export function parsePositiveIntegerId(id: number | string, entityName: string): number {
  const parsed = typeof id === 'number' ? id : Number(id);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${entityName} id: ${id}`);
  }

  return parsed;
}
