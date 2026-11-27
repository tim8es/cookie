<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    label,
    axis = "y",
    maxSize,
    className = "",
    children,
  }: {
    label: string;
    axis?: "x" | "y";
    maxSize?: string;
    className?: string;
    children: Snippet;
  } = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard users must be able to focus and scroll the labeled region) -->
<div
  class={"rhythm-scroll-area " + className}
  data-component="ScrollArea"
  data-axis={axis}
  role="region"
  aria-label={label}
  tabindex="0"
  style:max-block-size={axis === "y" ? maxSize : undefined}
  style:max-inline-size={axis === "x" ? maxSize : undefined}
>
  {@render children()}
</div>
