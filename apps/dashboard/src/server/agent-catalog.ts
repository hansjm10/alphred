import { asc } from 'drizzle-orm';
import { agentModels, type AlphredDatabase } from '@alphred/db';
import type {
  DashboardAgentModelOption,
  DashboardAgentProviderOption,
} from './dashboard-contracts';

const AGENT_PROVIDER_ORDER: readonly string[] = ['codex', 'claude'];

const AGENT_PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  codex: 'Codex',
  claude: 'Claude',
});

const FALLBACK_AGENT_MODELS: readonly DashboardAgentModelOption[] = Object.freeze([
  { provider: 'codex', model: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', isDefault: true, sortOrder: 10 },
  { provider: 'codex', model: 'gpt-5-codex', label: 'GPT-5-Codex', isDefault: false, sortOrder: 20 },
  { provider: 'codex', model: 'gpt-5-codex-mini', label: 'GPT-5-Codex-Mini', isDefault: false, sortOrder: 30 },
  {
    provider: 'claude',
    model: 'claude-3-7-sonnet-latest',
    label: 'Claude 3.7 Sonnet (Latest)',
    isDefault: true,
    sortOrder: 10,
  },
  {
    provider: 'claude',
    model: 'claude-3-5-haiku-latest',
    label: 'Claude 3.5 Haiku (Latest)',
    isDefault: false,
    sortOrder: 20,
  },
]);

export type AgentCatalog = {
  modelOptions: DashboardAgentModelOption[];
  providerOptions: DashboardAgentProviderOption[];
  modelSetByProvider: Map<string, Set<string>>;
  defaultModelByProvider: Map<string, string>;
};

function compareStringsByCodeUnit(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function providerSortRank(provider: string): number {
  const rank = AGENT_PROVIDER_ORDER.indexOf(provider);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

function resolveProviderLabel(provider: string): string {
  return AGENT_PROVIDER_LABELS[provider] ?? provider;
}

function sortAgentModelOptions(options: readonly DashboardAgentModelOption[]): DashboardAgentModelOption[] {
  return [...options].sort((left, right) => {
    const byProviderRank = providerSortRank(left.provider) - providerSortRank(right.provider);
    if (byProviderRank !== 0) {
      return byProviderRank;
    }

    const byProvider = compareStringsByCodeUnit(left.provider, right.provider);
    if (byProvider !== 0) {
      return byProvider;
    }

    const bySortOrder = left.sortOrder - right.sortOrder;
    if (bySortOrder !== 0) {
      return bySortOrder;
    }

    return compareStringsByCodeUnit(left.model, right.model);
  });
}

function toAgentCatalog(modelOptions: readonly DashboardAgentModelOption[]): AgentCatalog {
  const sortedModels = sortAgentModelOptions(modelOptions);
  const modelSetByProvider = new Map<string, Set<string>>();
  const defaultModelByProvider = new Map<string, string>();

  for (const option of sortedModels) {
    const modelSet = modelSetByProvider.get(option.provider) ?? new Set<string>();
    modelSet.add(option.model);
    modelSetByProvider.set(option.provider, modelSet);

    if (option.isDefault && !defaultModelByProvider.has(option.provider)) {
      defaultModelByProvider.set(option.provider, option.model);
    }
  }

  for (const provider of AGENT_PROVIDER_ORDER) {
    if (!defaultModelByProvider.has(provider)) {
      const fallback = sortedModels.find(option => option.provider === provider);
      if (fallback) {
        defaultModelByProvider.set(provider, fallback.model);
      }
    }
  }

  const providerNames = new Set<string>();
  for (const option of sortedModels) {
    providerNames.add(option.provider);
  }
  for (const provider of AGENT_PROVIDER_ORDER) {
    providerNames.add(provider);
  }

  const providerOptions = [...providerNames]
    .sort((left, right) => {
      const byRank = providerSortRank(left) - providerSortRank(right);
      if (byRank !== 0) {
        return byRank;
      }
      return compareStringsByCodeUnit(left, right);
    })
    .map((provider) => ({
      provider,
      label: resolveProviderLabel(provider),
      defaultModel: defaultModelByProvider.get(provider) ?? null,
    }));

  return {
    modelOptions: sortedModels,
    providerOptions,
    modelSetByProvider,
    defaultModelByProvider,
  };
}

export function loadAgentCatalog(db: Pick<AlphredDatabase, 'select'>): AgentCatalog {
  const rows = db
    .select({
      provider: agentModels.provider,
      model: agentModels.modelKey,
      label: agentModels.displayName,
      isDefault: agentModels.isDefault,
      sortOrder: agentModels.sortOrder,
    })
    .from(agentModels)
    .orderBy(asc(agentModels.provider), asc(agentModels.sortOrder), asc(agentModels.modelKey), asc(agentModels.id))
    .all();

  const modelOptions: DashboardAgentModelOption[] =
    rows.length === 0
      ? [...FALLBACK_AGENT_MODELS]
      : rows.map(row => ({
          provider: row.provider,
          model: row.model,
          label: row.label,
          isDefault: row.isDefault === 1,
          sortOrder: row.sortOrder,
        }));

  return toAgentCatalog(modelOptions);
}

export function resolveDefaultModelForProvider(
  provider: string | null,
  catalog: Pick<AgentCatalog, 'defaultModelByProvider'>,
): string | null {
  if (!provider) {
    return null;
  }

  return catalog.defaultModelByProvider.get(provider) ?? null;
}
