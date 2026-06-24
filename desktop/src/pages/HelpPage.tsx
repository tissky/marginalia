import { BookOpen, MessageSquare, Search, Settings } from "lucide-react";
import { Link } from "react-router-dom";

import { useI18n } from "@/lib/i18n";

interface ReferenceRowData {
  setting: string;
  meaning: string;
  recommended: string;
}

interface ReferenceGroupData {
  title: string;
  description: string;
  rows: ReferenceRowData[];
}

export function HelpPage() {
  const { t } = useI18n();
  const groups = settingsReferenceGroups(t);

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold">{t.help.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            {t.help.subtitle}
          </p>
        </header>

        <section className="rounded-md border border-border bg-bg-subtle p-4">
          <h2 className="text-sm font-semibold">{t.help.quickStartTitle}</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <HelpStep
              icon={Settings}
              title={t.help.stepConfigureTitle}
              body={t.help.stepConfigureBody}
              to="/settings"
              action={t.help.openSettings}
            />
            <HelpStep
              icon={BookOpen}
              title={t.help.stepImportTitle}
              body={t.help.stepImportBody}
              to="/library"
              action={t.help.openLibrary}
            />
            <HelpStep
              icon={MessageSquare}
              title={t.help.stepAskTitle}
              body={t.help.stepAskBody}
              to="/chat"
              action={t.help.openChat}
            />
            <HelpStep
              icon={Search}
              title={t.help.stepSearchTitle}
              body={t.help.stepSearchBody}
              to="/search"
              action={t.help.openSearch}
            />
          </div>
        </section>

        <section className="rounded-md border border-border bg-bg-subtle p-4">
          <h2 className="text-sm font-semibold">{t.help.faqTitle}</h2>
          <div className="mt-3 divide-y divide-border rounded-md border border-border bg-bg-base">
            {t.help.faq.map((item) => (
              <details key={item.q} className="px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">
                  {item.q}
                </summary>
                <p className="mt-2 text-sm leading-6 text-fg-muted">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </section>

        <section className="rounded-md border border-border bg-bg-subtle p-4">
          <h2 className="text-sm font-semibold">{t.help.referenceTitle}</h2>
          <p className="mt-1 text-xs text-fg-subtle">{t.help.referenceSubtitle}</p>
          <div className="mt-4 space-y-3">
            {groups.map((group, index) => (
              <details
                key={group.title}
                open={index === 0}
                className="rounded-md border border-border bg-bg-base"
              >
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                  {group.title}
                </summary>
                <div className="border-t border-border px-3 py-3">
                  <p className="mb-3 text-xs text-fg-subtle">{group.description}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[34rem] border-collapse text-left text-xs">
                      <thead>
                        <tr className="border-b border-border text-fg-muted">
                          <th className="w-36 py-2 pr-4 font-medium">
                            {t.help.referenceSetting}
                          </th>
                          <th className="py-2 pr-4 font-medium">
                            {t.help.referenceMeaning}
                          </th>
                          <th className="w-56 py-2 font-medium">
                            {t.help.referenceRecommended}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.rows.map((row) => (
                          <tr
                            key={row.setting}
                            className="border-b border-border/70 last:border-0"
                          >
                            <td className="py-2 pr-4 align-top font-medium text-fg-base">
                              {row.setting}
                            </td>
                            <td className="py-2 pr-4 align-top text-fg-muted">
                              {row.meaning}
                            </td>
                            <td className="py-2 align-top text-fg-muted">
                              {row.recommended}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function HelpStep({
  icon: Icon,
  title,
  body,
  to,
  action,
}: {
  icon: typeof Settings;
  title: string;
  body: string;
  to: string;
  action: string;
}) {
  return (
    <div className="rounded-md border border-border bg-bg-base p-3">
      <Icon className="h-4 w-4 text-accent" />
      <h3 className="mt-2 text-sm font-medium">{title}</h3>
      <p className="mt-1 min-h-16 text-xs leading-5 text-fg-muted">{body}</p>
      <Link
        to={to}
        className="mt-3 inline-flex rounded-md border border-border px-2 py-1 text-xs text-fg-muted hover:bg-bg-muted hover:text-fg-base"
      >
        {action}
      </Link>
    </div>
  );
}

function settingsReferenceGroups(
  t: ReturnType<typeof useI18n>["t"],
): ReferenceGroupData[] {
  const r = t.help.reference;
  return [
    {
      title: r.connectionTitle,
      description: r.connectionDescription,
      rows: [
        row(t.settings.apiBaseUrl, r.apiBaseUrlMeaning, r.apiBaseUrlRecommended),
        row(t.settings.apiToken, r.apiTokenMeaning, r.apiTokenRecommended),
      ],
    },
    {
      title: r.preferencesTitle,
      description: r.preferencesDescription,
      rows: [
        row(t.settings.language, r.languageMeaning, r.languageRecommended),
        row(t.settings.theme, r.themeMeaning, r.themeRecommended),
        row(t.settings.conflictPolicy, r.conflictMeaning, r.conflictRecommended),
        row(t.settings.agentTokenBudget, r.agentTokenMeaning, r.agentTokenRecommended),
        row(t.settings.executeTurnBudget, r.executeTurnsMeaning, r.executeTurnsRecommended),
        row(t.settings.compression, r.compressionMeaning, r.compressionRecommended),
        row(t.settings.concurrentIngest, r.concurrentIngestMeaning, r.concurrentIngestRecommended),
        row(t.settings.ingestLlmConcurrency, r.ingestConcurrencyMeaning, r.ingestConcurrencyRecommended),
        row(t.settings.statusRefresh, r.statusRefreshMeaning, r.statusRefreshRecommended),
        row(t.settings.compactSidebar, r.compactSidebarMeaning, r.compactSidebarRecommended),
      ],
    },
    {
      title: r.llmTitle,
      description: r.llmDescription,
      rows: [
        row(r.defaultProfile, r.defaultProfileMeaning, r.defaultProfileRecommended),
        row(r.chatProfile, r.chatProfileMeaning, r.chatProfileRecommended),
        row(r.reflectProfile, r.reflectProfileMeaning, r.reflectProfileRecommended),
        row(r.ingestProfile, r.ingestProfileMeaning, r.ingestProfileRecommended),
        row(r.visionProfile, r.visionProfileMeaning, r.visionProfileRecommended),
        row(t.llm.provider, r.providerMeaning, r.providerRecommended),
        row(t.llm.model, r.modelMeaning, r.modelRecommended),
        row(t.llm.baseUrl, r.baseUrlMeaning, r.baseUrlRecommended),
        row(t.llm.apiKey, r.apiKeyMeaning, r.apiKeyRecommended),
      ],
    },
    {
      title: r.embeddingTitle,
      description: r.embeddingDescription,
      rows: [
        row(t.settings.semanticRecall, r.semanticRecallMeaning, r.semanticRecallRecommended),
        row(t.settings.embeddingProvider, r.embeddingProviderMeaning, r.embeddingProviderRecommended),
        row(t.settings.embeddingApiKey, r.embeddingApiKeyMeaning, r.embeddingApiKeyRecommended),
        row(t.settings.embeddingBaseUrl, r.embeddingBaseUrlMeaning, r.embeddingBaseUrlRecommended),
        row(t.settings.embeddingModel, r.embeddingModelMeaning, r.embeddingModelRecommended),
        row(t.settings.embeddingDimensions, r.embeddingDimensionsMeaning, r.embeddingDimensionsRecommended),
        row(t.settings.embeddingBatchSize, r.embeddingBatchSizeMeaning, r.embeddingBatchSizeRecommended),
        row(t.settings.semanticRecallLimit, r.semanticRecallLimitMeaning, r.semanticRecallLimitRecommended),
        row(t.settings.semanticIndexBackend, r.semanticIndexBackendMeaning, r.semanticIndexBackendRecommended),
        row(t.settings.semanticIndex, r.semanticIndexMeaning, r.semanticIndexRecommended),
      ],
    },
    {
      title: r.rerankTitle,
      description: r.rerankDescription,
      rows: [
        row(t.settings.rerankEnabled, r.rerankMeaning, r.rerankRecommended),
        row(t.settings.rerankApiKey, r.rerankApiKeyMeaning, r.rerankApiKeyRecommended),
        row(t.settings.rerankBaseUrl, r.rerankBaseUrlMeaning, r.rerankBaseUrlRecommended),
        row(t.settings.rerankModel, r.rerankModelMeaning, r.rerankModelRecommended),
        row(t.settings.rerankTopN, r.rerankTopNMeaning, r.rerankTopNRecommended),
        row(t.settings.rerankMaxDocChars, r.rerankDocCharsMeaning, r.rerankDocCharsRecommended),
        row(t.settings.rerankConcurrency, r.rerankConcurrencyMeaning, r.rerankConcurrencyRecommended),
        row(t.settings.evidenceSelection, r.evidenceSelectionMeaning, r.evidenceSelectionRecommended),
      ],
    },
    {
      title: r.serverStatusTitle,
      description: r.serverStatusDescription,
      rows: [
        row(t.settings.kv.home, r.homeMeaning, r.homeRecommended),
        row(t.settings.kv.db, r.dbMeaning, r.dbRecommended),
        row(t.settings.kv.storage, r.storageMeaning, r.storageRecommended),
        row(t.settings.kv.worker, r.workerMeaning, r.workerRecommended),
        row(t.settings.kv.autoLifecycle, r.autoLifecycleMeaning, r.autoLifecycleRecommended),
        row(t.settings.kv.vision, r.visionStatusMeaning, r.visionStatusRecommended),
      ],
    },
  ];
}

function row(setting: string, meaning: string, recommended: string): ReferenceRowData {
  return { setting, meaning, recommended };
}
