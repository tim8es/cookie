<script lang="ts">
  export let error: string;
  export let notice: string;
  export let onDismissError: () => void;
  export let onDismissNotice: () => void;
</script>

{#if error}
  <div class="alert alert-error" role="alert">
    <span aria-hidden="true">!</span>
    <div><strong>Операция не выполнена</strong><p>{error}</p></div>
    <button class="alert-close" type="button" onclick={onDismissError} aria-label="Закрыть ошибку">×</button>
  </div>
{/if}
{#if notice}
  <div class="alert alert-ok" role="status">
    <span aria-hidden="true">✓</span>
    <p>{notice}</p>
    <button class="alert-close" type="button" onclick={onDismissNotice} aria-label="Закрыть сообщение">×</button>
  </div>
{/if}
