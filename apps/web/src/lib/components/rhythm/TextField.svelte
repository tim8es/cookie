<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";

  let {
    id,
    label,
    value = $bindable(""),
    type = "text",
    hint,
    error,
    disabled = false,
    required = false,
  }: {
    id: string;
    label: string;
    value?: string;
    type?: "text" | "email" | "tel" | "password";
    hint?: string;
    error?: string;
    disabled?: boolean;
    required?: boolean;
  } = $props();
  const description = $derived(
    [hint ? id + "-hint" : "", error ? id + "-error" : ""].filter(Boolean).join(" ") || undefined,
  );
</script>

<div class="rhythm-field" data-component="TextField">
  <label for={id}>{label}{required ? " *" : ""}</label>
  <Input
    {id}
    class="rhythm-input"
    {type}
    bind:value
    {required}
    {disabled}
    aria-invalid={error ? "true" : undefined}
    aria-describedby={description}
  />
  {#if hint}<small id={id + "-hint"} class="rhythm-muted">{hint}</small>{/if}
  {#if error}<p id={id + "-error"} class="rhythm-error" role="alert">{error}</p>{/if}
</div>
