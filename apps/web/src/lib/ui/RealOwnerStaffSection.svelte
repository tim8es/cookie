<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";
  import type { VerifiedOwnerSession } from "../owner-auth";
  import {
    StaffApiFailure,
    createRealStaff,
    readRealStaff,
    type RealStaffProfile,
  } from "../staff-api";

  export let session: VerifiedOwnerSession;

  let staff: RealStaffProfile[] = [];
  let loading = true;
  let loaded = false;
  let saving = false;
  let readError = "";
  let saveError = "";
  let notice = "";
  let displayName = "";
  let positionTitle = "";
  let pendingKey = "";

  function describe(reason: unknown): string {
    if (reason instanceof StaffApiFailure) {
      if (reason.reason === "unauthorized")
        return "Сеанс завершился или права изменились. Войдите заново.";
      if (reason.reason === "conflict")
        return "Данные повторного запроса отличаются. Измените форму.";
      if (reason.reason === "invalid-response")
        return "Сервер вернул неподтверждённые сведения о мастерах.";
    }
    return "Нет подтверждения от сервера. Проверьте соединение и повторите.";
  }

  async function refresh(): Promise<void> {
    loading = true;
    readError = "";
    try {
      staff = await readRealStaff(session);
      loaded = true;
    } catch (reason) {
      loaded = false;
      staff = [];
      readError = describe(reason);
    } finally {
      loading = false;
    }
  }

  function nameChanged(value: string): void {
    displayName = value;
    pendingKey = "";
    saveError = "";
  }

  function titleChanged(value: string): void {
    positionTitle = value;
    pendingKey = "";
    saveError = "";
  }

  async function save(): Promise<void> {
    if (saving || loading || !loaded) return;
    const name = displayName.normalize("NFC").trim();
    const title = positionTitle.normalize("NFC").trim();
    if (
      !name || [...name].length > 200 ||
      !title || [...title].length > 100
    ) {
      saveError = "Укажите имя мастера и специальность.";
      return;
    }
    const key = pendingKey || crypto.randomUUID();
    pendingKey = key;
    saving = true;
    saveError = "";
    notice = "";
    try {
      const saved = await createRealStaff(
        session,
        { displayName: name, positionTitle: title },
        key,
      );
      // A 200/201 response is server persisted; no local pretend success.
      staff = [...staff.filter((item) => item.id !== saved.id), saved];
      pendingKey = "";
      displayName = "";
      positionTitle = "";
      notice = "Мастер сохранён в PostgreSQL. Запись клиентов ещё не включена.";
      await refresh();
    } catch (reason) {
      // Keep the key for an uncertain response; an exact retry cannot duplicate.
      saveError = describe(reason);
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    void refresh();
  });
</script>

<section aria-labelledby="real-staff-title" class="real-staff-section">
  <div class="section-head">
    <div>
      <span class="eyebrow">КОМАНДА / ЗАЩИЩЁННЫЕ ДАННЫЕ</span>
      <h2 id="real-staff-title">Мастера салона</h2>
      <p>Профили сохраняются в PostgreSQL. Права входа, график и запись здесь не назначаются.</p>
    </div>
  </div>

  {#if readError}
    <div class="alert-error" role="alert">
      <p>{readError}</p>
      <Button
        type="button"
        variant="outline"
        onclick={() => void refresh()}
        disabled={loading}
      >Повторить загрузку</Button>
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
        <div><span class="eyebrow">СОТРУДНИКИ</span><h3>Сохранённые профили</h3></div>
        <Button type="button" variant="outline" onclick={() => void refresh()} disabled={loading || saving}>Обновить</Button>
      </div>
      {#if loading}
        <p role="status">Загружаем мастеров с сервера…</p>
      {:else if loaded && staff.length === 0}
        <div class="empty-mini"><strong>Мастеров пока нет</strong><p>Добавьте первого специалиста.</p></div>
      {:else if loaded}
        <div class="list-items">
          {#each staff as person (person.id)}
            <div class="entity-row">
              <span class="staff-avatar" aria-hidden="true">{person.displayName.slice(0, 1)}</span>
              <div class="entity-text">
                <strong>{person.displayName}</strong>
                <small>{person.positionTitle ?? "Без должности"} · {person.bookable ? "Есть доступность" : "Не опубликован"}</small>
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
            <h3>Новый мастер</h3>
            <label class="field">
              Имя или отображаемое название
              <Input
                value={displayName}
                oninput={(event) => nameChanged(event.currentTarget.value)}
                placeholder="Алекс Тест"
                maxlength={200}
                required
                disabled={saving}
              />
            </label>
            <label class="field">
              Должность или специализация
              <Input
                value={positionTitle}
                oninput={(event) => titleChanged(event.currentTarget.value)}
                placeholder="Парикмахер"
                maxlength={100}
                required
                disabled={saving}
              />
            </label>
          </div>
          <p class="owner-form-note">Имя и специализация не выдаются за роль пользователя. Профиль создаётся без привязки к филиалу и без доступных слотов.</p>
          <Button class="owner-submit" type="submit" disabled={saving || loading}>
            {saving ? "Сохраняем…" : "Сохранить профиль"}
          </Button>
        </form>
      </section>
    {/if}
  </div>
</section>
