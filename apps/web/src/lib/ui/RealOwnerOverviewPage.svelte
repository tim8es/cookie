<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import {
    WorkspaceOverviewFailure,
    readRealWorkspaceOverview,
    type RealWorkspaceOverview,
  } from "../workspace-overview-api";

  export let session: VerifiedOwnerSession;
  export let onOpenLocations: () => void;
  export let onOpenServices: () => void;
  export let onOpenStaff: () => void;

  let overview: RealWorkspaceOverview | null = null;
  let loading = true;
  let error = "";
  let activeRequest: AbortController | null = null;
  let expired = false;

  function description(reason: unknown): string {
    if (reason instanceof WorkspaceOverviewFailure) {
      if (reason.reason === "unauthorized")
        return "Сеанс завершился или права изменились. Войдите заново.";
      if (reason.reason === "invalid-response")
        return "Не удалось подтвердить данные организации на сервере.";
    }
    return "Сервер недоступен. Повторите загрузку.";
  }

  function expire(): void {
    expired = true;
    activeRequest?.abort();
    activeRequest = null;
    overview = null;
    loading = false;
    error = "Срок действия сеанса истёк. Войдите заново.";
  }

  async function refresh(): Promise<void> {
    if (expired || Date.now() / 1000 >= session.expiresAtUnixSeconds) {
      expire();
      return;
    }
    activeRequest?.abort();
    const request = new AbortController();
    activeRequest = request;
    overview = null;
    loading = true;
    error = "";
    try {
      const result = await readRealWorkspaceOverview(
        session,
        globalThis.fetch,
        request.signal,
      );
      if (activeRequest === request && !request.signal.aborted) {
        overview = result;
      }
    } catch (reason) {
      if (activeRequest === request && !request.signal.aborted) {
        error = description(reason);
      }
    } finally {
      if (activeRequest === request) {
        activeRequest = null;
        loading = false;
      }
    }
  }

  onMount(() => {
    void refresh();
    return () => {
      activeRequest?.abort();
      activeRequest = null;
    };
  });
</script>

<div class="section-head">
  <div>
    <span class="eyebrow">COOKIE / ОРГАНИЗАЦИЯ</span>
    <h1>{overview?.organization.displayName ?? "Обзор салона"}</h1>
    <p>Сведения об организации и филиалах из защищённого кабинета.</p>
  </div>
  <Button type="button" variant="outline" onclick={() => void refresh()} disabled={loading || expired}>
    Обновить
  </Button>
</div>

{#if loading}
  <div class="card" role="status"><p>Загружаем данные организации…</p></div>
{:else if error}
  <div class="alert-error" role="alert"><p>{error}</p></div>
{:else if overview}
  <div class="workspace-grid">
    <section class="card">
      <div class="card-title">
        <div><span class="eyebrow">ОРГАНИЗАЦИЯ</span><h2>Филиалы</h2></div>
        <span class="counter-pill">{overview.locations.length}</span>
      </div>
      {#if overview.locations.length === 0}
        <div class="empty-mini"><strong>Филиалов пока нет</strong></div>
      {:else}
        <div class="list-items">
          {#each overview.locations as location (location.locationId)}
            <div class="entity-row">
              <div class="entity-text">
                <strong>{location.displayName}</strong>
                <small>{location.timeZone ?? "Часовой пояс не задан"}</small>
              </div>
            </div>
          {/each}
        </div>
      {/if}
      <Button type="button" variant="outline" onclick={onOpenLocations}>Управлять филиалами</Button>
    </section>
    <section class="card">
      <span class="eyebrow">НАСТРОЙКА</span>
      <h2>Управление салоном</h2>
      <p>Настройте услуги и профили мастеров. Доступность записи и опубликованные графики пока не подтверждены.</p>
      <div class="owner-form-fields">
        <Button type="button" variant="outline" onclick={onOpenServices}>Услуги</Button>
        <Button type="button" variant="outline" onclick={onOpenStaff}>Мастера</Button>
      </div>
    </section>
  </div>
{/if}
