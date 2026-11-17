<script lang="ts">
  import { Button } from "../components/ui/button/index.js";
  import { brandPresets, compileBrandPreviewTokens, createBrandConfig, safeBrandPresetId, validateBrandConfig } from "../branding-config";
  import type { BrandConfigV1, BrandPresetId, BrandColorMode, BrandButtonRadius, BrandTypography, BrandAccentStyle } from "../branding-config";

  /** This component is transport-neutral. Server routes own save, assets, auth and publish. */
  export let organizationName: string;
  export let draft: BrandConfigV1;
  export let hasUnsavedChanges: boolean;
  export let publishedRevision: number | null = null;
  export let saving = false;
  export let publishing = false;
  export let uploading = false;
  export let canPublish = false;
  export let logoPreviewUrl: string | null = null;
  export let backgroundPreviewUrl: string | null = null;
  export let onChange: (value: BrandConfigV1) => void;
  export let onSave: () => void;
  export let onPublish: () => void;
  export let onUploadLogo: (file: File) => Promise<void> | void;
  export let onUploadBackground: (file: File) => Promise<void> | void;
  export let onRemoveLogo: () => void;
  export let onRemoveBackground: () => void;

  let uploadError = "";
  $: validationError = (() => {
    try { validateBrandConfig(draft); return ""; }
    catch (error) { return error instanceof Error ? error.message : "Недопустимые настройки"; }
  })();
  $: tokens = compileBrandPreviewTokens(draft);
  $: previewStyle = [
    "--preview-primary:" + tokens["--salon-primary"],
    "--preview-primary-ink:" + tokens["--salon-hero-ink"],
    "--preview-accent:" + tokens["--salon-accent"],
    "--preview-accent-ink:" + tokens["--salon-accent-ink"],
    "--preview-paper:" + tokens["--salon-page-background"],
    "--preview-ink:" + tokens["--salon-page-ink"],
    "--preview-radius:" + tokens["--salon-button-radius"],
    "--preview-font:" + tokens["--salon-font-heading"],
    "--preview-accent-width:" + tokens["--salon-accent-width"],
  ].join(";");

  function change<K extends keyof BrandConfigV1>(key: K, value: BrandConfigV1[K]): void {
    onChange({ ...draft, [key]: value });
  }
  function choosePreset(id: BrandPresetId): void {
    onChange({ ...createBrandConfig(id), logoAssetId: draft.logoAssetId, backgroundAssetId: draft.backgroundAssetId });
  }
  function changeMode(mode: BrandColorMode): void {
    const background = brandPresets.find((item) => item.id === draft.presetId && item.mode === mode)
      ?? brandPresets.find((item) => item.mode === mode);
    onChange({ ...draft, mode, backgroundColor: background?.backgroundColor ?? draft.backgroundColor });
  }
  async function upload(event: Event, kind: "logo" | "background"): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size === 0 || file.size > 2 * 1024 * 1024) {
      uploadError = "Поддерживаются PNG, JPEG и WebP до 2 МБ.";
      return;
    }
    uploadError = "";
    try {
      if (kind === "logo") await onUploadLogo(file);
      else await onUploadBackground(file);
    } catch {
      uploadError = "Файл не сохранён на сервере. Повторите попытку.";
    }
  }
  function sameOriginUrl(value: string | null): string | null {
    if (!value || typeof window === "undefined") return null;
    try {
      const url = new URL(value, window.location.origin);
      return url.origin === window.location.origin && /^https?:$/.test(url.protocol) ? url.href : null;
    } catch { return null; }
  }
  $: safeLogo = sameOriginUrl(logoPreviewUrl);
  $: safeBackground = sameOriginUrl(backgroundPreviewUrl);
</script>

<div class="brand-editor">
  <div class="brand-editor-head">
    <div>
      <small>СТРАНИЦА ЗАПИСИ · ОФОРМЛЕНИЕ</small>
      <h1>Внешний вид салона</h1>
      <p>Выберите готовый дизайн и добавьте фирменные детали. Всё остальное настроится автоматически.</p>
    </div>
    <span class="brand-state" role="status">
      {publishedRevision === null ? "Не опубликовано" : "Опубликовано · версия " + publishedRevision}
    </span>
  </div>
  <div class="brand-editor-grid">
    <section class="brand-settings" aria-label="Настройки дизайна">
      <fieldset>
        <legend>1. Готовый стиль</legend>
        <p>Ровно четыре варианта — светлые и тёмные.</p>
        <div class="brand-presets">
          {#each brandPresets as item (item.id)}
            <button type="button" class:active={draft.presetId === item.id}
              aria-pressed={draft.presetId === item.id}
              onclick={() => choosePreset(item.id)}>
              <span class="brand-swatch" style:background={item.backgroundColor} aria-hidden="true">
                <i style:background={item.primaryColor}></i><b style:background={item.accentColor}></b>
              </span>
              <strong>{item.label}</strong><small>{item.description}</small>
            </button>
          {/each}
        </div>
      </fieldset>
      <fieldset>
        <legend>2. Цвета</legend>
        <p>Выберите основной, акцентный цвет и фон страницы. Контраст проверяется при сохранении.</p>
        <div class="brand-colors">
          <label><span>Основной</span><input type="color" value={draft.primaryColor}
            oninput={(e) => change("primaryColor", e.currentTarget.value)} /></label>
          <label><span>Акцент</span><input type="color" value={draft.accentColor}
            oninput={(e) => change("accentColor", e.currentTarget.value)} /></label>
          <label><span>Фон</span><input type="color" value={draft.backgroundColor}
            oninput={(e) => change("backgroundColor", e.currentTarget.value)} /></label>
        </div>
      </fieldset>
      <fieldset>
        <legend>3. Детали</legend>
        <div class="brand-selects">
          <label><span>Режим</span>
            <select value={draft.mode} onchange={(e) => changeMode(e.currentTarget.value as BrandColorMode)}>
              <option value="light">Светлый</option><option value="dark">Тёмный</option>
            </select>
          </label>
          <label><span>Округление кнопок</span>
            <select value={draft.buttonRadius} onchange={(e) => change("buttonRadius", e.currentTarget.value as BrandButtonRadius)}>
              <option value="compact">Строгие</option><option value="soft">Мягкие</option>
              <option value="round">Округлые</option><option value="pill">Капсулы</option>
            </select>
          </label>
          <label><span>Типографика</span>
            <select value={draft.typography} onchange={(e) => change("typography", e.currentTarget.value as BrandTypography)}>
              <option value="editorial">Редакционная</option><option value="modern">Современная</option>
              <option value="humanist">Гуманистическая</option><option value="classic">Классическая</option>
            </select>
          </label>
          <label><span>Акцентные элементы</span>
            <select value={draft.accentStyle} onchange={(e) => change("accentStyle", e.currentTarget.value as BrandAccentStyle)}>
              <option value="minimal">Минимальные</option><option value="line">Линии</option>
              <option value="filled">Заливка</option><option value="highlight">Выделение</option>
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>4. Свои изображения</legend>
        <p>Файлы передаются серверу через защищённый tenant-scoped upload. Внешние ссылки недоступны.</p>
        <div class="brand-assets">
          <label><span>Логотип · PNG, JPEG, WebP до 2 МБ</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading}
              onchange={(e) => void upload(e, "logo")} /></label>
          {#if draft.logoAssetId}
            <Button type="button" variant="outline" disabled={uploading} onclick={onRemoveLogo}>Удалить логотип</Button>
          {/if}
          <label><span>Изображение баннера · необязательно</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading}
              onchange={(e) => void upload(e, "background")} /></label>
          {#if draft.backgroundAssetId}
            <Button type="button" variant="outline" disabled={uploading} onclick={onRemoveBackground}>Убрать баннер</Button>
          {/if}
        </div>
        {#if uploading}<p role="status" class="brand-info">Загрузка изображения…</p>{/if}
        {#if uploadError}<p role="alert" class="brand-error">{uploadError}</p>{/if}
      </fieldset>
      {#if validationError}
        <p role="alert" class="brand-error">
          Нельзя сохранить: требуется контраст не менее 4,5:1 и допустимые настройки.
          <small>{validationError}</small>
        </p>
      {/if}
      <div class="brand-actions">
        <Button type="button" variant="outline" disabled={saving || publishing || uploading}
          onclick={() => choosePreset(safeBrandPresetId(draft.presetId))}>Сбросить цвета и оформление</Button>
        <Button type="button" disabled={!!validationError || !hasUnsavedChanges || saving || publishing || uploading}
          onclick={onSave}>{saving ? "Сохранение…" : "Сохранить черновик"}</Button>
        <Button type="button" variant="outline"
          disabled={!!validationError || !canPublish || hasUnsavedChanges || saving || publishing || uploading}
          onclick={onPublish}>{publishing ? "Публикация…" : "Опубликовать"}</Button>
      </div>
      <p class="brand-info">Предпросмотр не означает публикацию. Страница клиента меняется только после ответа сервера.</p>
    </section>

    <aside class="brand-preview" aria-label="Предпросмотр публичной страницы">
      <div class="brand-preview-head"><strong>Как увидит клиент</strong>
        <small>{validationError ? "Показан безопасный пресет" : "Предпросмотр"}</small>
      </div>
      <div class="brand-preview-page" style={previewStyle}>
        <div class="brand-preview-logo">
          {#if safeLogo}<img src={safeLogo} alt={"Логотип " + organizationName} />
          {:else}<span aria-hidden="true">{organizationName.trim().slice(0, 1).toUpperCase() || "C"}</span>{/if}
          <strong>{organizationName}</strong>
        </div>
        <div class="brand-preview-hero">
          {#if safeBackground}<img src={safeBackground} alt="" aria-hidden="true" />{/if}
          <small>ОНЛАЙН-ЗАПИСЬ</small>
          <h2>Время для себя.</h2>
          <p>Выберите услугу, мастера и удобное время.</p>
        </div>
        <div class="brand-preview-form">
          <strong>Запись на услугу</strong>
          <span>Услуга и специалист</span><span>Дата и время визита</span>
          <div class="brand-preview-cta">Выбрать время</div>
        </div>
      </div>
    </aside>
  </div>
</div>

<style>
  .brand-editor { color: #34283c; }
  .brand-editor-head { display: flex; justify-content: space-between; gap: 18px; margin-bottom: 21px; }
  .brand-editor-head small { font-size: 10px; font-weight: 750; letter-spacing: .1em; color: #725c7c; }
  .brand-editor-head h1 { margin: 8px 0; font-size: clamp(24px, 3vw, 36px); }
  .brand-editor-head p { max-width: 60ch; color: #71647a; font-size: 13px; line-height: 1.6; }
  .brand-state { white-space: nowrap; font-size: 11px; padding: 9px; border-radius: 999px; background: #f5eff6; color: #5a4265; height: fit-content; }
  .brand-editor-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(280px, .9fr); gap: 18px; align-items: start; }
  .brand-settings, .brand-preview { min-width: 0; background: white; border: 1px solid #e7dee9; border-radius: 15px; padding: 22px; }
  fieldset { border: 0; margin: 0 0 25px; padding: 0; min-width: 0; }
  legend { font-size: 16px; font-weight: 760; } fieldset > p { color: #796d80; font-size: 12px; margin: 8px 0 13px; line-height: 1.55; }
  .brand-presets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
  .brand-presets button { cursor: pointer; display: flex; flex-direction: column; text-align: left; gap: 5px; min-height: 116px; background: white; color: #43384b; border: 1px solid #ded4e2; border-radius: 10px; padding: 10px; }
  .brand-presets button.active { border-color: #644b70; box-shadow: inset 0 0 0 1px #644b70; }
  .brand-presets button:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid #b9a5c6; outline-offset: 2px; }
  .brand-presets button strong { font-size: 12px; } .brand-presets button small { font-size: 10px; line-height: 1.3; color: #776a7e; }
  .brand-swatch { display: flex; gap: 5px; width: 100%; height: 33px; padding: 6px; border-radius: 7px; }
  .brand-swatch i { width: 60%; border-radius: 4px; } .brand-swatch b { width: 20%; border-radius: 4px; }
  .brand-colors { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .brand-colors label, .brand-selects label, .brand-assets label { display: flex; flex-direction: column; gap: 7px; font-size: 12px; font-weight: 650; min-width: 0; }
  input[type=color] { width: 100%; height: 45px; padding: 4px; background: white; border: 1px solid #dcd3e1; border-radius: 9px; cursor: pointer; }
  .brand-selects { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; }
  select { width: 100%; min-height: 45px; padding: 8px; font: inherit; font-size: 13px; border: 1px solid #dcd3e1; border-radius: 8px; background: white; color: #33293b; }
  .brand-assets { display: flex; flex-direction: column; gap: 12px; }
  input[type=file] { font-size: 12px; max-width: 100%; }
  .brand-actions { display: flex; flex-wrap: wrap; gap: 9px; }
  .brand-actions :global(button) { min-height: 44px; flex-grow: 1; }
  .brand-info { font-size: 11px; color: #71657a; line-height: 1.55; }
  .brand-error { border: 1px solid #d8a2a5; color: #853942; background: #fff6f6; padding: 10px; border-radius: 9px; font-size: 12px; line-height: 1.5; }
  .brand-error small { display: block; }
  .brand-preview { position: sticky; top: 18px; }
  .brand-preview-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 14px; font-size: 13px; }
  .brand-preview-head small { font-size: 11px; color: #7c7080; }
  .brand-preview-page { padding: 13px; background: var(--preview-paper); color: var(--preview-ink); border: 1px solid #ded5e1; border-radius: 13px; }
  .brand-preview-logo { display: flex; align-items: center; gap: 9px; margin-bottom: 13px; font-size: 13px; }
  .brand-preview-logo img { width: 38px; height: 38px; object-fit: contain; }
  .brand-preview-logo span { display: grid; place-items: center; width: 34px; height: 34px; background: var(--preview-primary); color: var(--preview-primary-ink); border-radius: 9px; font-size: 20px; }
  .brand-preview-logo strong { overflow-wrap: anywhere; }
  .brand-preview-hero { isolation: isolate; position: relative; overflow: hidden; padding: 21px; border-radius: 10px; background: var(--preview-primary); color: var(--preview-primary-ink); }
  .brand-preview-hero img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: -1; opacity: .18; }
  .brand-preview-hero small { font-size: 9px; letter-spacing: .1em; font-weight: 760; }
  .brand-preview-hero h2 { font-family: var(--preview-font); font-size: 30px; letter-spacing: -.035em; line-height: 1.05; margin: 11px 0; }
  .brand-preview-hero h2::after { display: block; content: ""; width: 38px; height: var(--preview-accent-width); background: var(--preview-accent); margin-top: 10px; }
  .brand-preview-hero p { margin: 0; font-size: 11px; line-height: 1.5; }
  .brand-preview-form { margin-top: 10px; border-radius: 10px; background: var(--preview-primary); color: var(--preview-primary-ink); padding: 16px; display: flex; flex-direction: column; gap: 9px; font-size: 12px; }
  .brand-preview-form > span { border: 1px solid currentColor; padding: 10px; border-radius: 8px; }
  .brand-preview-cta { background: var(--preview-accent); color: var(--preview-accent-ink); min-height: 42px; border-radius: var(--preview-radius); display: grid; place-items: center; font-size: 12px; font-weight: 750; }
  @media (max-width: 900px) { .brand-editor-grid { grid-template-columns: minmax(0, 1fr); } .brand-preview { position: static; } }
  @media (max-width: 480px) {
    .brand-editor-head { flex-direction: column; }
    .brand-settings, .brand-preview { padding: 14px; }
    .brand-presets { grid-template-columns: minmax(0, 1fr); }
    .brand-selects { grid-template-columns: minmax(0, 1fr); }
  }
</style>
