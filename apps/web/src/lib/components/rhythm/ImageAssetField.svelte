<script lang="ts">
  import ActionButton from "./ActionButton.svelte";

  let {
    id,
    label,
    imageSrc,
    hint,
    error,
    busy = false,
    disabled = false,
    onFile,
    onRemove,
  }: {
    id: string;
    label: string;
    imageSrc?: string;
    hint?: string;
    error?: string;
    busy?: boolean;
    disabled?: boolean;
    onFile: (file: File) => void;
    onRemove?: () => void;
  } = $props();
</script>

<div class="rhythm-field" data-component="ImageAssetField">
  <label for={id}>{label}</label>
  {#if imageSrc}
    <img class="rhythm-image-preview" src={imageSrc} alt={"Предпросмотр: " + label} />
  {/if}
  <input
    {id}
    class="rhythm-file-input"
    type="file"
    accept="image/png,image/jpeg,image/webp"
    disabled={busy || disabled}
    aria-invalid={error ? "true" : undefined}
    aria-describedby={[hint ? id + "-hint" : "", error ? id + "-error" : ""].filter(Boolean).join(" ") || undefined}
    onchange={(event) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      input.value = "";
      if (file && !busy && !disabled) onFile(file);
    }}
  />
  {#if hint}<small id={id + "-hint"} class="rhythm-muted">{hint}</small>{/if}
  {#if error}<p id={id + "-error"} class="rhythm-error" role="alert">{error}</p>{/if}
  {#if busy}<p role="status">Обработка изображения…</p>{/if}
  {#if imageSrc && onRemove}
    <div class="rhythm-actions">
      <ActionButton tone="danger" disabled={busy || disabled} onclick={onRemove}>Удалить изображение</ActionButton>
    </div>
  {/if}
</div>
