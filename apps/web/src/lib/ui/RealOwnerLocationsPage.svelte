<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import {
    LocationApiFailure,
    createRealLocation,
    emptyLocationDraft,
    locationCreateIsUncertain,
    locationDraftFromForm,
    readRealLocations,
    type RealLocation,
  } from "../locations-api";

  export let session: VerifiedOwnerSession;

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
      locations = await readRealLocations(session);
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
      );
      // No optimistic success: the record came from a committed PG transaction.
      locations = [...locations.filter((branch) => branch.id !== saved.id), saved];
      pendingKey = "";
      uncertain = false;
      ({ displayName, timeZone } = emptyLocationDraft());
      notice = "Филиал сохранён в PostgreSQL. Графики и запись клиентов пока не опубликованы.";
      await refresh();
    } catch (reason) {
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

<div class="section-head">
  <div>
    <span class="eyebrow">kuki / ЗАЩИЩЁННЫЙ КАБИНЕТ</span>
    <h1>Филиалы</h1>
    <p>Адреса и графики добавляются отдельно. У каждого филиала свой реальный часовой пояс.</p>
  </div>
</div>

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
      <div>
        <span class="eyebrow">ОРГАНИЗАЦИЯ</span>
        <h2>Сохранённые филиалы</h2>
      </div>
      <Button type="button" variant="outline" onclick={() => void refresh()} disabled={loading || saving}>
        Обновить
      </Button>
    </div>
    {#if loading}
      <p role="status">Загружаем филиалы с сервера…</p>
    {:else if loaded && locations.length === 0}
      <div class="empty-mini">
        <strong>Филиалов пока нет</strong>
        <p>Добавьте первый филиал с часовой зоной.</p>
      </div>
    {:else if loaded}
      <div class="list-items">
        {#each locations as location (location.id)}
          <div class="entity-row">
            <div class="entity-text">
              <strong>{location.displayName}</strong>
              <small>{location.timeZone ?? "Часовой пояс не задан"}</small>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  {#if loaded}
    <section class="card owner-form-panel">
      <form class="owner-form" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <div class="owner-form-fields">
          <h2>Новый филиал</h2>
          <label class="field">
            Название
            <Input
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
