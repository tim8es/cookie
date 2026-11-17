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
  import {
    AppearanceAssetApiFailure,
    readAppearanceAssetCapability,
    readAppearanceAssetPreview,
    uploadAppearanceAsset,
    type AppearanceAssetKind,
  } from "../appearance-assets-api";
  import { readRealWorkspaceOverview } from "../workspace-overview-api";

  export let session: VerifiedOwnerSession;

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
        config.logoAssetId ? readAppearanceAssetPreview(session, "logo", config.logoAssetId, globalThis.fetch, request.signal) : null,
        config.backgroundAssetId ? readAppearanceAssetPreview(session, "background", config.backgroundAssetId, globalThis.fetch, request.signal) : null,
      ]);
      if (active !== request || request.signal.aborted) return;
      if (logo) setPreview("logo", logo);
      if (background) setPreview("background", background);
    } catch {
      if (active === request) assetError = "Не удалось загрузить сохранённые изображения. Ссылки в черновике не изменены.";
    }
  }

  async function upload(kind: AppearanceAssetKind, file: File): Promise<void> {
    if (!assetsAvailable || uploading || loading || saving || needsReload || !draft || active) return;
    const request = new AbortController();
    active = request;
    uploading = true;
    assetError = "";
    notice = "";
    try {
      const receipt = await uploadAppearanceAsset(session, kind, file, globalThis.fetch, request.signal);
      const preview = await readAppearanceAssetPreview(session, kind, receipt.id, globalThis.fetch, request.signal, receipt);
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
    if (!assetsAvailable || saving || uploading || needsReload || !draft) return;
    clearPreview(kind);
    draft = { ...draft, [kind === "logo" ? "logoAssetId" : "backgroundAssetId"]: null };
    notice = "Изображение убрано из черновика. Файл в хранилище не удалён.";
  }

  async function reload(): Promise<void> {
    if (saving || uploading) return;
    active?.abort();
    const request = new AbortController();
    active = request;
    loading = true;
    error = "";
    notice = "";
    stored = null;
    draft = null;
    assetsAvailable = false;
    assetError = "";
    clearPreviews();
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
      try {
        assetsAvailable = await readAppearanceAssetCapability(session, globalThis.fetch, request.signal);
      } catch {
        if (active === request) assetError = "Не удалось проверить доступность загрузки.";
      }
      if (active === request && !request.signal.aborted) await loadPreviews(result.config, request);
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
    if (saving || uploading || needsReload || !stored) return;
    draft = value;
    notice = "";
  }

  async function save(): Promise<void> {
    if (saving || uploading || loading || needsReload || !stored || !draft || !dirty) return;
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
      await loadPreviews(current.config, request);
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
  <p>Версия черновика: {stored.revision}. Публичная страница пока не подключена.</p>
  <BrandingSettingsEditor
    {organizationName}
    {draft}
    hasUnsavedChanges={dirty}
    {saving}
    canPublish={false}
    publishedStatusKnown={false}
    {assetsAvailable}
    {uploading}
    {logoPreviewUrl}
    {backgroundPreviewUrl}
    allowPrivateBlobPreview={true}
    onChange={change}
    onSave={() => void save()}
    onPublish={() => undefined}
    onUploadLogo={(file) => upload("logo", file)}
    onUploadBackground={(file) => upload("background", file)}
    onRemoveLogo={() => remove("logo")}
    onRemoveBackground={() => remove("background")}
  />
{/if}
