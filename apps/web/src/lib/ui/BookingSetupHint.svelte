<script lang="ts">
  /** The parent determines which setup step is still incomplete. */
  export let onContinueSetup: () => void;
</script>

<div class="setup-shortcut">
  <span>Для полного сценария сначала создайте услугу, мастера и график.</span>
  <button class="btn btn-secondary" type="button" onclick={onContinueSetup}>
    Продолжить настройку →
  </button>
</div>
