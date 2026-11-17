<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import BrandingSettingsEditor from "./BrandingSettingsEditor.svelte";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import type { BrandConfigV1 } from "../branding-config";
  import {
    AppearanceApiFailure,
    readRealAppearanceDraft,
    saveRealAppearanceDraft,
    sameBrandConfig,
    type RealAppearanceDraft,
  } from "../appearance-api";
  import { readRealWorkspaceOverview } from "../workspace-overview-api";

  export let session: VerifiedOwnerSession;

  let stored: RealAppearanceDraft | null = null;
  let draft: BrandConfigV1 | null = null;
  let organizationName = "";
  let loading = true;
  let saving = false;
  let needsReload = false;
  let error = "";
  let notice = "";
  let active: AbortController | null = null;

  $: dirty = !!stored && !!draft && !sameBrandConfig(stored.config, draft);

  function describe(reason: unknown): string {
    if (reason instanceof AppearanceApiFailure) {
      if (reason.reason === "unauthorized") return "Сеанс или права изменились. Войдите заново.";
      if (reason.reason === "conflict") return "Сервер отклонил изменение версии или изображения. Загрузите актуальный черновик.";
    }
    return "Сервер не подтвердил операцию. Загрузите актуальный черновик перед повторным сохранением.";
  }

  async function reload(): Promise<void> {
    if (saving) return;
    active?.abort();
    const request = new AbortController();
    active = request;
    loading = true;
    error = "";
    notice = "";
    stored = null;
    draft = null;
    try {
      const [result, overview] = await Promise.all([
        readRealAppearanceDraft(session, globalThis.fetch, request.signal),
        readRealWorkspaceOverview(session, globalThis.fetch, request.signal),
      ]);
      if (active !== request || request.signal.aborted) return;
      stored = result;
      draft = result.config;
      organizationName = overview.organization.displayName;
      needsReload = false;
    } catch (reason) {
      if (active === request) error = describe(reason);
    } finally {
      if (active === request) {
        active = null;
        loading = false;
      }
    }
  }

  function change(value: BrandConfigV1): void {
    if (saving || needsReload || !stored) return;
    draft = value;
    notice = "";
  }

  async function save(): Promise<void> {
    if (saving || loading || needsReload || !stored || !draft || !dirty) return;
    const request = new AbortController();
    active = request;
    saving = true;
    error = "";
    notice = "";
    try {
      await saveRealAppearanceDraft(session, stored.revision, draft, globalThis.fetch, request.signal);
      const current = await readRealAppearanceDraft(session, globalThis.fetch, request.signal);
      if (active !== request || request.signal.aborted) return;
      stored = current;
      draft = current.config;
      notice = "Черновик сохранён на сервере. Показана актуальная версия.";
    } catch (reason) {
      if (active !== request) return;
      needsReload = true;
      // A lost response may mean COMMIT succeeded. Never retry automatically,
      // overwrite a later revision, or present local data as persisted.
      error = describe(reason);
    } finally {
      if (active === request) {
        active = null;
        saving = false;
      }
    }
  }

  onMount(() => {
    void reload();
    return () => {
      active?.abort();
      active = null;
    };
  });
</script>

{#if loading}
  <div class="card" role="status">Загружаем оформление с сервера…</div>
{:else if error}
  <section class="alert-error" role="alert">
    <p>{error}</p>
    <Button type="button" variant="outline" onclick={() => void reload()}>
      Загрузить актуальный черновик
    </Button>
    {#if needsReload}<p>Несохранённые изменения будут сброшены при загрузке.</p>{/if}
  </section>
{:else if stored && draft}
  {#if notice}<p role="status">{notice}</p>{/if}
  <p>Версия черновика: {stored.revision}. Публичная страница и загрузка изображений пока не подключены.</p>
  <BrandingSettingsEditor
    {organizationName}
    {draft}
    hasUnsavedChanges={dirty}
    {saving}
    canPublish={false}
    publishedStatusKnown={false}
    assetsAvailable={false}
    onChange={change}
    onSave={() => void save()}
    onPublish={() => undefined}
    onUploadLogo={() => undefined}
    onUploadBackground={() => undefined}
    onRemoveLogo={() => undefined}
    onRemoveBackground={() => undefined}
  />
{/if}
