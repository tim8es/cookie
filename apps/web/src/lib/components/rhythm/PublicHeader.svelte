<script lang="ts">
  import type { Snippet } from "svelte";
  import Avatar from "./Avatar.svelte";
  let {
    title,
    subtitle,
    initials,
    logo,
    actions,
  }: {
    title: string;
    subtitle?: string;
    initials: string;
    logo?: string;
    actions?: Snippet;
  } = $props();
</script>

<header class="rhythm-public-header" data-component="PublicHeader">
  <div class="rhythm-public-identity">
    <Avatar {initials} imageSrc={logo} />
    <div class="rhythm-copy">
      <strong>{title}</strong>
      {#if subtitle}<small class="rhythm-muted">{subtitle}</small>{/if}
    </div>
  </div>
  {#if actions}<div class="rhythm-public-actions">{@render actions()}</div>{/if}
</header>
