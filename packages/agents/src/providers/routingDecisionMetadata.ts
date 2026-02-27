import {
  routingDecisionContractLinePrefix,
  routingDecisionSignals,
  type RoutingDecisionSignal,
} from '@alphred/shared';

type RecordReader = (value: unknown) => Record<string, unknown> | undefined;

const routingDecisionSignalSet: ReadonlySet<RoutingDecisionSignal> = new Set(routingDecisionSignals);
const routingDecisionContractLineRegex = /^result\.metadata\.routingDecision\s*:\s*(approved|changes_requested|blocked|retry)$/i;

function unwrapInlineCodeLine(line: string): string {
  if (line.length >= 2 && line.startsWith('`') && line.endsWith('`')) {
    return line.slice(1, line.length - 1).trim();
  }

  return line;
}

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

function readRoutingDecisionFromResultContent(resultContent: string): RoutingDecisionSignal | undefined {
  const lines = resultContent.split(/\r?\n/u);
  for (const rawLine of lines) {
    const trimmedLine = unwrapInlineCodeLine(rawLine.trim());
    if (!trimmedLine.startsWith(routingDecisionContractLinePrefix.slice(0, -1))) {
      continue;
    }

    const match = trimmedLine.match(routingDecisionContractLineRegex);
    if (!match) {
      continue;
    }

    const value = match[1];
    const routingDecision = toRoutingDecisionSignal(value?.toLowerCase());
    if (routingDecision) {
      return routingDecision;
    }
  }

  return undefined;
}

export function createRoutingResultMetadata(
  sdkPayload: Record<string, unknown>,
  readRecord: RecordReader,
  options?: {
    resultContent?: string;
  },
): Record<string, unknown> | undefined {
  const metadataRecords = collectMetadataRecords(sdkPayload, readRecord);
  const routingDecision = readRoutingDecisionFromMetadataRecords(metadataRecords, 'routingDecision');

  if (routingDecision) {
    return {
      routingDecision,
      routingDecisionSource: 'provider_result_metadata',
    };
  }

  const resultContent = options?.resultContent?.trim();
  if (!resultContent) {
    return undefined;
  }

  const fallbackRoutingDecision = readRoutingDecisionFromResultContent(resultContent);
  if (!fallbackRoutingDecision) {
    return undefined;
  }

  return {
    routingDecision: fallbackRoutingDecision,
    routingDecisionSource: 'result_content_contract_fallback',
  };
}
