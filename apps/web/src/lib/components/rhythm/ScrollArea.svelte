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

<!-- Native scrolling preserves touch, wheel, keyboard and platform scrollbar behavior. -->
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
