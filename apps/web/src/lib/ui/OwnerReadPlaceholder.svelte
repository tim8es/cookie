<script lang="ts">
  export let label: string;
</script>

<div class="loading-preview" role="status">
  <p class="sr-only">{label}</p>
  <span aria-hidden="true"></span>
  <span aria-hidden="true"></span>
  <span aria-hidden="true"></span>
</div>

<style>
  .loading-preview {
    display: grid;
    gap: 0.625rem;
    padding-block: 0.5rem;
  }
  span {
    display: block;
    height: 0.875rem;
    border-radius: var(--cookie-radius-control);
    background: var(--cookie-border);
  }
  span:nth-child(1) { width: min(100%, 16rem); }
  span:nth-child(2) { width: min(80%, 12rem); }
  span:nth-child(3) { width: min(55%, 8rem); }
</style>
