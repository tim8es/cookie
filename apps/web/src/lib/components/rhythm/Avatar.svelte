<script lang="ts">
  let { initials, imageSrc }: { initials: string; imageSrc?: string } = $props();
  let failedSrc = $state<string | undefined>(undefined);
</script>

<span class="rhythm-avatar" aria-hidden="true">
  {#if imageSrc && failedSrc !== imageSrc}
    <img src={imageSrc} alt="" onerror={() => (failedSrc = imageSrc)} />
  {:else}
    {initials}
  {/if}
</span>
