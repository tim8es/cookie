<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import BrandingSettingsEditor from "./BrandingSettingsEditor.svelte";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import type { OwnerReads } from "../owner-reads";
  import { brandPresets, type BrandConfigV1 } from "../branding-config";
  import {
    AppearanceApiFailure,
    readRealAppearanceDraft,
    saveRealAppearanceDraft,
    sameBrandConfig,
    type RealAppearanceDraft,
  } from "../appearance-api";
  import {
    AppearanceAssetApiFailure,
    readAppearanceAssetCapability,
    readAppearanceAssetPreview,
    uploadAppearanceAsset,
    type AppearanceAssetKind,
  } from "../appearance-assets-api";
  import {
    readAppearancePublicationState,
    readPublishedAppearanceSnapshot,
    publishAppearanceDraft,
    type AppearancePublicationReceipt,
    type AppearancePublicationState,
  } from "../appearance-publication-api";
  import { readRealWorkspaceOverview } from "../workspace-overview-api";

  export let session: VerifiedOwnerSession;
  export let reads: OwnerReads;

  let stored: RealAppearanceDraft | null = null;
  let draft: BrandConfigV1 | null = null;
  let organizationName = "";
  let assetsAvailable = false;
  let uploading = false;
  let assetError = "";
  let logoPreviewUrl: string | null = null;
  let backgroundPreviewUrl: string | null = null;
  let loading = true;
  let saving = false;
  let publishing = false;
  let publication: AppearancePublicationState | null = null;
  let publicationError = "";
  let publishedSnapshot: AppearancePublicationReceipt | null = null;
  let publishedSnapshotError = "";
  let needsReload = false;
  let error = "";
  let notice = "";
  let active: AbortController | null = null;

  $: dirty = !!stored && !!draft && !sameBrandConfig(stored.config, draft);

  $: publishedMismatch = !!publication &&
    publication.publishedRevision !== (publishedSnapshot?.revision ?? null);
  $: publishedPreset = publishedSnapshot
    ? brandPresets.find((preset) => preset.id === publishedSnapshot?.config.presetId)?.label ?? ""
    : "";

  $: canPublish = !!publication && !!stored && publication.canPublish
    && publication.draftRevision === stored.revision && stored.revision > 0
    && publication.publishedRevision !== stored.revision
    && !loading && !dirty && !saving && !uploading && !publishing && !needsReload
    && !publishedMismatch && !publishedSnapshotError;

  async function refreshPublication(request: AbortController): Promise<AppearancePublicationState | null> {
    publication = null;
    publicationError = "";
    try {
      const current = await readAppearancePublicationState(session, reads.fetch, request.signal);
      if (active !== request || request.signal.aborted) return null;
      if (current && current.draftRevision !== stored?.revision) {
        publicationError = "Версия черновика изменилась. Загрузите актуальные данные.";
        return null;
      }
      publication = current;
      return current;
    } catch {
      if (active === request) publicationError = "Не удалось проверить статус публикации.";
      return null;
    }
  }

  async function refreshPublished(request: AbortController): Promise<AppearancePublicationReceipt | null> {
    publishedSnapshot = null;
    publishedSnapshotError = "";
    try {
      const current = await readPublishedAppearanceSnapshot(session, reads.fetch, request.signal);
      if (active !== request || request.signal.aborted) return null;
      if (current && stored && current.revision > stored.revision) {
        publishedSnapshotError = "Опубликованная версия новее загруженного черновика. Обновите данные.";
        return null;
      }
      publishedSnapshot = current;
      return current;
    } catch {
      if (active === request && !request.signal.aborted)
        publishedSnapshotError = "Не удалось подтвердить опубликованную конфигурацию на сервере.";
      return null;
    }
  }

  function describe(reason: unknown): string {
    if (reason instanceof AppearanceApiFailure) {
      if (reason.reason === "unauthorized") return "Сеанс или права изменились. Войдите заново.";
      if (reason.reason === "conflict") return "Сервер отклонил изменение версии или изображения. Загрузите актуальный черновик.";
    }
    return "Сервер не подтвердил операцию. Загрузите актуальный черновик перед повторным сохранением.";
  }

  function clearPreview(kind: AppearanceAssetKind): void {
    const old = kind === "logo" ? logoPreviewUrl : backgroundPreviewUrl;
    if (old) URL.revokeObjectURL(old);
    if (kind === "logo") logoPreviewUrl = null;
    else backgroundPreviewUrl = null;
  }

  function clearPreviews(): void {
    clearPreview("logo");
    clearPreview("background");
  }

  function setPreview(kind: AppearanceAssetKind, blob: Blob): void {
    clearPreview(kind);
    const url = URL.createObjectURL(blob);
    if (kind === "logo") logoPreviewUrl = url;
    else backgroundPreviewUrl = url;
  }

  async function loadPreviews(config: BrandConfigV1, request: AbortController): Promise<void> {
    clearPreviews();
    if (!assetsAvailable) return;
    try {
      const [logo, background] = await Promise.all([
        config.logoAssetId ? readAppearanceAssetPreview(session, "logo", config.logoAssetId, reads.fetch, request.signal) : null,
        config.backgroundAssetId ? readAppearanceAssetPreview(session, "background", config.backgroundAssetId, reads.fetch, request.signal) : null,
      ]);
      if (active !== request || request.signal.aborted) return;
      if (logo) setPreview("logo", logo);
      if (background) setPreview("background", background);
    } catch {
      if (active === request) assetError = "Не удалось загрузить сохранённые изображения. Ссылки в черновике не изменены.";
    }
  }

  async function upload(kind: AppearanceAssetKind, file: File): Promise<void> {
    if (!assetsAvailable || uploading || loading || saving || publishing || needsReload || !draft || active) return;
    const request = new AbortController();
    active = request;
    uploading = true;
    assetError = "";
    notice = "";
    try {
      const receipt = await uploadAppearanceAsset(session, kind, file, reads.fetch, request.signal);
      const preview = await readAppearanceAssetPreview(session, kind, receipt.id, reads.fetch, request.signal, receipt);
      if (active !== request || request.signal.aborted || !draft) return;
      setPreview(kind, preview);
      draft = { ...draft, [kind === "logo" ? "logoAssetId" : "backgroundAssetId"]: receipt.id };
      notice = "Изображение загружено. Сохраните черновик, чтобы привязать его к оформлению.";
    } catch (reason) {
      if (active !== request) return;
      if (reason instanceof AppearanceAssetApiFailure && reason.reason === "quota")
        assetError = "Достигнут лимит хранилища.";
      else if (reason instanceof AppearanceAssetApiFailure && reason.reason === "unauthorized") {
        assetsAvailable = false;
        clearPreviews();
        assetError = "Сеанс или права изменились. Загрузка недоступна.";
      } else assetError = "Сервер не подтвердил загрузку или предпросмотр. Черновик не изменён.";
    } finally {
      if (active === request) {
        active = null;
        uploading = false;
      }
    }
  }

  function remove(kind: AppearanceAssetKind): void {
    if (!assetsAvailable || saving || publishing || uploading || needsReload || !draft) return;
    clearPreview(kind);
    draft = { ...draft, [kind === "logo" ? "logoAssetId" : "backgroundAssetId"]: null };
    notice = "Изображение убрано из черновика. Файл в хранилище не удалён.";
  }

  async function reload(): Promise<void> {
    if (saving || uploading || publishing) return;
    active?.abort();
    const request = new AbortController();
    active = request;
    loading = true;
    error = "";
    notice = "";
    stored = null;
    draft = null;
    assetsAvailable = false;
    publication = null;
    publicationError = "";
    publishedSnapshot = null;
    publishedSnapshotError = "";
    assetError = "";
    clearPreviews();
    try {
      const [result, overview, capability] = await Promise.all([
        readRealAppearanceDraft(session, reads.fetch, request.signal),
        readRealWorkspaceOverview(session, reads.fetch, request.signal),
        readAppearanceAssetCapability(session, reads.fetch, request.signal).catch(() => null),
      ]);
      if (active !== request || request.signal.aborted) return;
      stored = result;
      draft = result.config;
      organizationName = overview.organization.displayName;
      needsReload = false;
      assetsAvailable = capability ?? false;
      if (capability === null) assetError = "Не удалось проверить доступность загрузки.";
      await Promise.all([
        loadPreviews(result.config, request),
        refreshPublication(request),
        refreshPublished(request),
      ]);
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
    if (saving || publishing || uploading || needsReload || !stored) return;
    draft = value;
    notice = "";
  }

  async function save(): Promise<void> {
    if (saving || publishing || uploading || loading || needsReload || !stored || !draft || !dirty) return;
    const request = new AbortController();
    active = request;
    saving = true;
    error = "";
    notice = "";
    try {
      await saveRealAppearanceDraft(session, stored.revision, draft, reads.fetch, request.signal);
      const current = await readRealAppearanceDraft(session, reads.fetch, request.signal);
      if (active !== request || request.signal.aborted) return;
      stored = current;
      draft = current.config;
      await Promise.all([
        loadPreviews(current.config, request),
        refreshPublication(request),
        refreshPublished(request),
      ]);
      if (active !== request || request.signal.aborted) return;
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

  async function publish(): Promise<void> {
    if (!canPublish || !stored || active || dirty) return;
    const target = stored;
    const request = new AbortController();
    active = request;
    publishing = true;
    publication = null;
    publishedSnapshot = null;
    notice = "";
    error = "";
    try {
      await publishAppearanceDraft(session, target, reads.fetch, request.signal);
      const current = await readRealAppearanceDraft(session, reads.fetch, request.signal);
      if (active !== request || request.signal.aborted) return;
      stored = current;
      draft = current.config;
      const [, confirmed, snapshot] = await Promise.all([
        loadPreviews(current.config, request),
        refreshPublication(request),
        refreshPublished(request),
      ]);
      if (active !== request || request.signal.aborted) return;
      if (confirmed && confirmed.publishedRevision === target.revision
        && snapshot && snapshot.revision === target.revision
        && sameBrandConfig(snapshot.config, target.config)) {
        notice = "Сервер подтвердил публикацию оформления версии " + target.revision + ". Публичная ссылка ещё не подключена.";
      } else {
        publication = null;
        publishedSnapshot = null;
        publicationError = "Результат публикации не подтверждён актуальным состоянием сервера. Загрузите данные.";
      }
    } catch {
      if (active !== request) return;
      needsReload = true;
      error = "Публикация не подтверждена. Загрузите актуальное состояние перед повторной попыткой.";
    } finally {
      if (active === request) {
        active = null;
        publishing = false;
      }
    }
  }

  onMount(() => {
    void reload();
    return () => {
      active?.abort();
      active = null;
      clearPreviews();
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
  {#if assetError}<p role="alert">{assetError}</p>{/if}
  {#if publicationError || publishedSnapshotError || publishedMismatch}
    <p role="alert">{publicationError || publishedSnapshotError || "Состояние публикации и опубликованная версия не совпадают. Обновите данные."}</p>
    <Button type="button" variant="outline" disabled={saving || uploading || publishing || dirty} onclick={() => void reload()}>Обновить состояние</Button>
  {/if}
  <p>Версия черновика: {stored.revision}. Публичная страница пока не подключена.</p>
  {#if publishedSnapshot}
    <p role="status">На сервере опубликована версия {publishedSnapshot.revision} ({publishedPreset}) от {new Date(publishedSnapshot.publishedAt).toLocaleString("ru-RU")}. {stored.revision !== publishedSnapshot.revision ? "Текущий черновик ещё не опубликован." : "Черновик совпадает с опубликованной версией."}</p>
  {:else if !publicationError && !publishedSnapshotError && !publishedMismatch}
    <p>Опубликованная конфигурация не подтверждена. В этом кабинете показан черновик.</p>
  {/if}
  {#if publication && !publication.canPublish}<p>Публикация недоступна: требуется разрешение организации и право пользователя.</p>{/if}
  <BrandingSettingsEditor
    showHeading={false}
    responsivePreview={true}
    {organizationName}
    {draft}
    hasUnsavedChanges={dirty}
    {saving}
    {publishing}
    {canPublish}
    publishedRevision={publishedSnapshot?.revision ?? null}
    publishedStatusKnown={publishedSnapshot !== null || (publication !== null && publication.publishedRevision === null)}
    {assetsAvailable}
    {uploading}
    {logoPreviewUrl}
    {backgroundPreviewUrl}
    allowPrivateBlobPreview={true}
    onChange={change}
    onSave={() => void save()}
    onPublish={() => void publish()}
    onUploadLogo={(file) => upload("logo", file)}
    onUploadBackground={(file) => upload("background", file)}
    onRemoveLogo={() => remove("logo")}
    onRemoveBackground={() => remove("background")}
  />
{/if}
