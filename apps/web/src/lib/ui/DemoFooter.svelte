<script lang="ts">
  export let showReset: boolean;
  export let busy: boolean;
  export let onReset: () => void;
</script>

<footer class="footer">
  <span>kuki · frontend preview · запись не отправляется на сервер</span>
  {#if showReset}
    <button type="button" onclick={onReset} disabled={busy}>Сбросить демо-данные</button>
  {/if}
</footer>
