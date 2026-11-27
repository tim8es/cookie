<script lang="ts">
  import type { SegmentOption } from "./contracts.js";

  let {
    label,
    options,
    selected,
    onChange,
    disabled = false,
  }: {
    label: string;
    options: readonly SegmentOption[];
    selected: readonly string[];
    onChange: (selected: string[]) => void;
    disabled?: boolean;
  } = $props();
</script>

<fieldset class="rhythm-check-group" data-component="CheckGroup" {disabled}>
  <legend>{label}</legend>
  {#each options as option (option.id)}
    <label class="rhythm-check-row">
      <input
        type="checkbox"
        checked={selected.includes(option.id)}
        disabled={option.disabled}
        onchange={(event) => {
          const checked = event.currentTarget.checked;
          onChange(
            checked
              ? [...new Set([...selected, option.id])]
              : selected.filter((id) => id !== option.id),
          );
        }}
      />
      <span>{option.label}</span>
    </label>
  {/each}
</fieldset>
