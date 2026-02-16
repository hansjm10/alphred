import { routingDecisionSignals, type RoutingDecisionSignal } from '@alphred/shared';

type RecordReader = (value: unknown) => Record<string, unknown> | undefined;

const routingDecisionSignalSet: ReadonlySet<RoutingDecisionSignal> = new Set(routingDecisionSignals);

function toRoutingDecisionSignal(value: unknown): RoutingDecisionSignal | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  if (!routingDecisionSignalSet.has(value as RoutingDecisionSignal)) {
    return undefined;
  }

  return value as RoutingDecisionSignal;
}

function readRoutingDecisionFromMetadataRecords(
  metadataRecords: readonly (Record<string, unknown> | undefined)[],
  key: 'routingDecision',
): RoutingDecisionSignal | undefined {
  for (const metadataRecord of metadataRecords) {
    if (!metadataRecord) {
      continue;
    }

    const routingDecision = toRoutingDecisionSignal(metadataRecord[key]);
    if (routingDecision) {
      return routingDecision;
    }
  }

  return undefined;
}

function collectMetadataRecords(
  sdkPayload: Record<string, unknown>,
  readRecord: RecordReader,
): (Record<string, unknown> | undefined)[] {
  const resultRecord = readRecord(sdkPayload.result);
  return [
    sdkPayload,
    readRecord(sdkPayload.metadata),
    readRecord(sdkPayload.result_metadata),
    readRecord(sdkPayload.resultMetadata),
    resultRecord,
    resultRecord ? readRecord(resultRecord.metadata) : undefined,
  ];
}

export function createRoutingResultMetadata(
  sdkPayload: Record<string, unknown>,
  readRecord: RecordReader,
): Record<string, unknown> | undefined {
  const metadataRecords = collectMetadataRecords(sdkPayload, readRecord);
  const routingDecision = readRoutingDecisionFromMetadataRecords(metadataRecords, 'routingDecision');

  if (!routingDecision) {
    return undefined;
  }

  return { routingDecision };
}
