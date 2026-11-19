<script lang="ts">
  export let apiMode = false;
  export let label = "";
</script>

<header class="onboarding-header">
  <div class="onboarding-brand">
    <span class="brand-seal" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <span>kuki<span class="onboarding-brand-dot">.</span></span>
  </div>
  <div class="onboarding-header-meta">
    <span class="onboarding-header-pulse" aria-hidden="true"></span>
    {label || (apiMode ? "Вход и регистрация" : "Демо без регистрации")}
  </div>
</header>
