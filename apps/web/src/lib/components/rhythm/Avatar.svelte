<script lang="ts">
  let { initials, imageSrc }: { initials: string; imageSrc?: string } = $props();
  let failedSrc = $state<string | undefined>(undefined);
</script>

<span class="rhythm-avatar" aria-hidden="true">
  {#if imageSrc && failedSrc !== imageSrc}
    {#key imageSrc}
      <img src={imageSrc} alt="" onerror={(event) => (failedSrc = event.currentTarget.getAttribute("src") ?? undefined)} />
    {/key}
  {:else}
    {initials}
  {/if}
</span>
