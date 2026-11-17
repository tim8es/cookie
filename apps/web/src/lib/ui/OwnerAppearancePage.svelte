<script lang="ts">
  import type { SalonTheme } from "../model";
  import { salonThemes } from "../appearance";

  export let organizationName: string;
  export let theme: SalonTheme;
  export let introduction: string;
  export let hasUnsavedAppearance = false;
  export let onThemeChange: (value: SalonTheme) => void;
  export let onIntroductionChange: (value: string) => void;
  export let onSave: () => void;
  export let onOpenBooking: () => void;

  $: selected = salonThemes.find((item) => item.id === theme) ?? salonThemes[0];
  $: monogram = organizationName.trim().slice(0, 1).toLocaleUpperCase("ru-RU") || "С";
</script>

<div class="section-head">
  <div>
    <span class="eyebrow">СТРАНИЦА ЗАПИСИ · ДЕМО</span>
    <h1>Оформление</h1>
    <p>Настройте первое впечатление от салона. Эти изменения сохраняются только в данной вкладке браузера.</p>
  </div>
</div>

<div class="appearance-layout">
  <section class="card appearance-editor" aria-label="Параметры оформления">
    <form onsubmit={(event) => { event.preventDefault(); onSave(); }}>
      <fieldset class="appearance-fieldset">
        <legend>Цветовая тема</legend>
        <p>Четыре готовых сочетания с подобранным контрастом. Свои цвета и логотип — в следующем этапе.</p>
        <div class="appearance-presets">
          {#each salonThemes as preset (preset.id)}
            <button type="button" class:chosen={theme === preset.id}
              aria-pressed={theme === preset.id}
              onclick={() => onThemeChange(preset.id)}>
              <span class="appearance-preset-swatch" style:background={preset.hero} aria-hidden="true">
                <span style:background={preset.accent}></span>
              </span>
              <span class="appearance-preset-label">
                <strong>{preset.label}</strong>
                <small>{preset.description}</small>
              </span>
              <span class="appearance-preset-check" aria-hidden="true">{theme === preset.id ? "✓" : ""}</span>
            </button>
          {/each}
        </div>
      </fieldset>
      <label class="appearance-introduction-field">
        <strong>Текст приглашения</strong>
        <span>Появится в начале клиентской формы записи.</span>
        <textarea rows="3" maxlength="120" value={introduction}
          oninput={(event) => onIntroductionChange(event.currentTarget.value)} required></textarea>
      </label>
      <p class="appearance-counter">{introduction.length} / 120</p>
      <button type="submit" class="appearance-save" disabled={!hasUnsavedAppearance}>Сохранить оформление демо</button>
      <p class="appearance-safety">Настройки здесь не опубликованы для реальных клиентов и не изменяют сервер.</p>
    </form>
  </section>

  <aside class="card appearance-preview" aria-label="Предпросмотр оформления">
    <div class="appearance-preview-header">
      <div>
        <span class="eyebrow">ПРЕДПРОСМОТР</span>
        <h2>Так видит клиент</h2>
      </div>
      <span class="appearance-preview-badge">{hasUnsavedAppearance ? "Не сохранено" : "Сохранено · демо"}</span>
    </div>
    <div class="appearance-preview-window"
      style={`--preview-hero:${selected.hero};--preview-accent:${selected.accent};--preview-monogram:${selected.monogram};--preview-ink:${selected.monogramInk};`}>
      <div class="appearance-preview-salon">
        <span class="appearance-preview-monogram" aria-hidden="true">{monogram}</span>
        <strong>{organizationName}</strong>
      </div>
      <div class="appearance-preview-hero">
        <h3>Выберите время.</h3>
        <p>{introduction}</p>
      </div>
      <div class="appearance-preview-form">
        <strong>Запись на услугу</strong>
        <div class="appearance-preview-placeholder">Услуга и специалист</div>
        <div class="appearance-preview-placeholder">Дата и время визита</div>
      </div>
      <div class="appearance-preview-credit">Работает на <strong>kuki</strong></div>
    </div>
    <p class="appearance-preview-hint" role="status">
      {hasUnsavedAppearance
        ? "В предпросмотре показаны изменения. Сохраните их, чтобы увидеть на странице записи."
        : "Это миниатюра страницы записи. Откройте демо-запись, чтобы проверить сохранённое оформление."}
    </p>
    <button type="button" class="appearance-open" onclick={onOpenBooking} disabled={hasUnsavedAppearance}>Открыть демо-запись</button>
  </aside>
</div>
