<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import type { VerifiedCustomerSession } from "../owner-auth";
  import { readCustomerAppointments, CustomerAppointmentsError, type CustomerAppointments } from "../staging-customer-appointments-api";
  export let session: VerifiedCustomerSession;
  export let onUnauthorized: () => void;
  let snapshot: CustomerAppointments | null = null;
  let busy = true;
  let error = "";
  let mounted = true;
  async function refresh(): Promise<void> {
    snapshot = null; error = ""; busy = true;
    try {
      const result = await readCustomerAppointments(session);
      if (mounted && Date.now()/1000 < session.expiresAtUnixSeconds) snapshot = result;
      else if (mounted) onUnauthorized();
    } catch (reason) {
      if (!mounted) return;
      if (reason instanceof CustomerAppointmentsError && reason.reason === "unauthorized") onUnauthorized();
      else error = reason instanceof CustomerAppointmentsError && reason.reason === "forbidden"
        ? "Доступ к записям отозван." : "Не удалось получить записи с сервера.";
    } finally { if (mounted) busy = false; }
  }
  const statusLabels = { Confirmed:"Подтверждена", CancelledByClient:"Отменена клиентом", CancelledByBusiness:"Отменена салоном", Completed:"Завершена", NoShow:"Неявка" };
  function format(value: string, zone: string): string {
    return new Intl.DateTimeFormat("ru-RU",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",timeZoneName:"shortOffset"}).format(new Date(value));
  }
  function price(value: string): string {
    const amount=BigInt(value);
    return new Intl.NumberFormat("ru-RU").format(amount/100n)+","+String(amount%100n).padStart(2,"0")+" ₽";
  }
  onMount(() => { void refresh(); return () => {mounted=false;}; });
</script>
<section class="card" aria-label="Мои записи staging">
  <div class="card-title">
    <h2>Мои записи</h2>
    <Button type="button" variant="outline" disabled={busy} onclick={() => void refresh()}>Обновить мои записи</Button>
  </div>
  {#if busy}<p role="status">Проверяем записи на сервере…</p>
  {:else if error}<p role="alert" class="alert-error">{error}</p>
  {:else if snapshot}
    {#if snapshot.appointments.length===0}<p role="status">У вас пока нет записей.</p>{/if}
    <div class="appointments-list">
      {#each snapshot.appointments as appointment (appointment.bookingId)}
        <article class="appointment-item">
          <strong>{appointment.serviceName}</strong>
          <span>{statusLabels[appointment.status]}</span>
          <p>{format(appointment.startAt,appointment.timeZone)} – {format(appointment.endAt,appointment.timeZone)}</p>
          <p>{appointment.staffName} · {appointment.locationName}</p>
          <p>Стоимость записи: {price(appointment.priceKopecks)}</p>
          <small class="appointment-id">ID: {appointment.bookingId}</small>
        </article>
      {/each}
    </div>
    {#if snapshot.hasMore}<p>Показаны 200 записей с наиболее поздней датой начала. Более ранние записи здесь не отображаются.</p>{/if}
  {/if}
  <p class="owner-form-note">Данные на момент обновления. Отмена и перенос пока недоступны. Названия услуги, мастера и филиала актуальны на момент просмотра; стоимость сохранена при записи.</p>
</section>
<style>
  .appointments-list {display:grid;gap:12px;min-width:0;}
  .appointment-item {display:grid;gap:4px;min-width:0;padding:12px;border:1px solid currentColor;border-radius:10px;}
  .appointment-id {overflow-wrap:anywhere;}
</style>
