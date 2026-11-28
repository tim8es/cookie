<script lang="ts">
  import { Plus } from "@lucide/svelte";
  import ActionButton from "../components/rhythm/ActionButton.svelte";
  import PageHeader from "../components/rhythm/PageHeader.svelte";
  import { onMount } from "svelte";
  import RecordRow from "../components/rhythm/RecordRow.svelte";
  import EmptyState from "../components/rhythm/EmptyState.svelte";
  import ThemeScope from "../components/rhythm/ThemeScope.svelte";
  import type { OwnerReads } from "../owner-reads";
  import OwnerReadPlaceholder from "./OwnerReadPlaceholder.svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import {
    LocationApiFailure,
    createRealLocation,
    emptyLocationDraft,
    locationCreateIsUncertain,
    locationDraftFromForm,
    type RealLocation,
  } from "../locations-api";

  export let session: VerifiedOwnerSession;
  export let reads: OwnerReads;

  let locationNameInput: HTMLInputElement | null = null;
  let locations: RealLocation[] = [];
  let loading = true;
  let loaded = false;
  let saving = false;
  let readError = "";
  let saveError = "";
  let notice = "";
  let { displayName, timeZone } = emptyLocationDraft();
  let pendingKey = "";
  let uncertain = false;
  let query = "";
  $: normalizedQuery = query.trim().normalize("NFC").toLocaleLowerCase("ru-RU");
  $: visibleLocations = locations.filter(location =>
    (location.displayName + " " + (location.timeZone ?? "")).normalize("NFC").toLocaleLowerCase("ru-RU").includes(normalizedQuery));

  function description(reason: unknown): string {
    if (reason instanceof LocationApiFailure) {
      if (reason.reason === "unauthorized")
        return "Сеанс завершился или права изменились. Войдите заново.";
      if (reason.reason === "conflict")
        return "Этот ключ уже использован с другим филиалом. Измените форму.";
      if (reason.reason === "limit")
        return "Достигнут лимит из 100 филиалов в текущей версии.";
      if (reason.reason === "invalid-request")
        return "Сервер отклонил название или часовой пояс филиала.";
      if (reason.reason === "invalid-response")
        return "Сервер вернул неподтверждённый формат филиалов.";
    }
    return "Нет подтверждения от сервера. Повторите запрос.";
  }

  async function refresh(): Promise<void> {
    loading = true;
    readError = "";
    try {
      locations = await reads.locations.load();
      loaded = true;
    } catch (reason) {
      loaded = false;
      locations = [];
      readError = description(reason);
    } finally {
      loading = false;
    }
  }

  function editName(value: string): void {
    if (saving || uncertain) return;
    displayName = value;
    pendingKey = "";
    saveError = "";
  }

  function editZone(value: string): void {
    if (saving || uncertain) return;
    timeZone = value;
    pendingKey = "";
    saveError = "";
  }

  async function save(): Promise<void> {
    if (!loaded || saving || loading) return;
    const draft = locationDraftFromForm(displayName, timeZone);
    if (!draft) {
      saveError = "Укажите корректное название и существующий IANA-часовой пояс, например Europe/Moscow.";
      return;
    }

    saving = true;
    saveError = "";
    notice = "";
    const key = pendingKey || crypto.randomUUID();
    pendingKey = key;
    try {
      const saved = await createRealLocation(
        session,
        draft,
        key,
        reads.fetch,
      );
      // No optimistic success: the record came from a committed PG transaction.
      locations = [...locations.filter((branch) => branch.id !== saved.id), saved];
      pendingKey = "";
      uncertain = false;
      ({ displayName, timeZone } = emptyLocationDraft());
      notice = "Филиал сохранён в PostgreSQL. Графики и запись клиентов пока не опубликованы.";
      reads.locations.invalidate();
      reads.staff.invalidate();
      reads.invalidateCalendars();
      reads.overview.invalidate();
      await refresh();
    } catch (reason) {
      reads.locations.invalidate();
      reads.overview.invalidate();
      reads.staff.invalidate();
      reads.invalidateCalendars();
      // An unknown COMMIT may have succeeded; do not allow a changed payload/key.
      uncertain = locationCreateIsUncertain(uncertain, reason);
      saveError = description(reason);
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    void refresh();
  });
</script>

<PageHeader title="Филиалы" organization={session.organizationName}
  description="У каждого филиала свой часовой пояс. Адреса и графики добавляются отдельно.">
  {#snippet secondaryActions()}
    <ActionButton onclick={() => void refresh()} disabled={loading || saving}>Обновить</ActionButton>
  {/snippet}
  {#snippet primaryAction()}
    {#if loaded && !uncertain}
      <ActionButton tone="primary" onclick={() => locationNameInput?.focus()} disabled={loading || saving}>
        <Plus size={17} aria-hidden="true" />Новый филиал
      </ActionButton>
    {/if}
  {/snippet}
</PageHeader>

{#if readError}
  <div class="alert-error" role="alert">
    <p>{readError}</p>
    <Button type="button" variant="outline" onclick={() => void refresh()} disabled={loading}>
      Повторить загрузку
    </Button>
  </div>
{/if}
{#if saveError}
  <div class="alert-error" role="alert"><p>{saveError}</p></div>
{/if}
{#if notice}
  <div class="alert-ok" role="status"><p>{notice}</p></div>
{/if}

<div class="workspace-grid">
  <section class="card">
    <div class="card-title">
      <h2>Сохранённые филиалы</h2>
      {#if loaded && !loading}<span class="counter-pill">{locations.length}</span>{/if}
    </div>
    <ThemeScope>
      {#if loading}
        <OwnerReadPlaceholder label="Загружаем филиалы с сервера…" />
      {:else if loaded && locations.length === 0}
        <EmptyState title="Филиалов пока нет" description="Добавьте первый филиал с часовой зоной."
          actionLabel={!saving && !uncertain ? "Добавить филиал" : undefined}
          onAction={() => locationNameInput?.focus()} />
      {:else if loaded}
        <div class="rhythm-stack location-directory" aria-label="Фильтры филиалов">
          <label class="field">Поиск филиалов
            <Input type="search" bind:value={query} placeholder="Название или часовой пояс" />
          </label>
          <p class="rhythm-muted" role="status">Найдено: {visibleLocations.length} из {locations.length}</p>
        </div>
        {#if visibleLocations.length === 0}
          <EmptyState title="Филиалы не найдены" description="Измените поисковый запрос."
            actionLabel="Сбросить поиск" onAction={() => query = ""} />
        {:else}
          <div class="list-items" aria-label="Сохранённые филиалы">
            {#each visibleLocations as location (location.id)}
              <RecordRow record={{
                title: location.displayName,
                subtitle: location.timeZone ?? "Часовой пояс не задан",
              }} />
            {/each}
          </div>
        {/if}
      {/if}
    </ThemeScope>
  </section>

  {#if loaded}
    <section class="card owner-form-panel">
      <form class="owner-form" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <div class="owner-form-fields">
          <h2>Новый филиал</h2>
          <label class="field">
            Название
            <Input
              bind:ref={locationNameInput}
              value={displayName}
              oninput={(event) => editName(event.currentTarget.value)}
              placeholder="Студия на Невском"
              maxlength={200}
              required
              disabled={saving || uncertain}
            />
          </label>
          <label class="field">
            Часовой пояс IANA
            <Input
              value={timeZone}
              oninput={(event) => editZone(event.currentTarget.value)}
              placeholder="Europe/Moscow"
              maxlength={128}
              required
              disabled={saving || uncertain}
            />
          </label>
        </div>
        <p class="owner-form-note">
          Например: Europe/Moscow, Europe/Kaliningrad или Asia/Yekaterinburg.
          Сервер проверяет пояс и сохраняет его вместе с филиалом.
        </p>
        {#if uncertain}
          <p class="owner-form-note" role="status">Результат создания не подтверждён. Повторите запрос с прежними параметрами; не создавайте другой филиал до подтверждения.</p>
        {/if}
        <Button class="owner-submit" type="submit" disabled={saving || loading}>
          {saving ? "Сохраняем…" : uncertain ? "Повторить создание" : "Создать филиал"}
        </Button>
      </form>
    </section>
  {/if}
</div>
