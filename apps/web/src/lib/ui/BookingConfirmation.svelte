<script lang="ts">
  import { CalendarDays, Check, Hash, ShieldCheck, UserRound } from "@lucide/svelte";
  import { Badge } from "../components/ui/badge/index.js";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { longDate } from "../dates";
  import type { BookingView, Location } from "../model";

  export let booking: BookingView;
  export let organizationName: string;
  export let location: Location | undefined;
  export let serviceName: (id: string) => string;
  export let staffName: (id: string) => string;
  export let onCreateAnother: () => void;
</script>

<Card.Root class="success-screen booking-confirmation">
  <div class="confirmation-top">
    <div class="confirmation-seal" aria-hidden="true"><Check size={28} strokeWidth={1.9}/></div>
    <Badge variant="secondary" class="confirmation-status">Создано локально</Badge>
    <span class="confirmation-edition">{organizationName} · демо-запись</span>
    <h2>Демо-запись<br/><em>создана.</em></h2>
    <p>Это тестовая запись в браузере. Она <strong>не подтверждена backend</strong> и не резервирует время у мастера.</p>
  </div>
  <div class="confirmation-receipt">
    <div class="confirmation-receipt-head">
      <span>Ваш тестовый визит</span>
      <span>01 / 01</span>
    </div>
    <dl class="success-receipt">
      <div><dt>Услуга</dt><dd>{serviceName(booking.serviceId)}</dd></div>
      <div><dt><CalendarDays size={15} aria-hidden="true"/> Дата и время</dt><dd>{longDate(booking.date)}, {booking.time}</dd></div>
      <div><dt><UserRound size={15} aria-hidden="true"/> Мастер</dt><dd>{staffName(booking.staffId)}</dd></div>
      <div><dt>Филиал</dt><dd>{location?.name ?? "—"}{#if location?.address}<small class="confirmation-address">{location.address}</small>{/if}</dd></div>
      <div><dt><Hash size={15} aria-hidden="true"/> Демо-ID</dt><dd class="mono">{booking.id.slice(0, 8)}</dd></div>
    </dl>
    <div class="confirmation-note"><ShieldCheck size={16} aria-hidden="true"/> Настоящее подтверждение записи будет выполнять сервер.</div>
  </div>
  <div class="button-row confirmation-actions">
    <Button type="button" class="btn-primary confirmation-primary" size="lg" onclick={onCreateAnother}>
      Ещё одна демо-запись
    </Button>
  </div>
</Card.Root>
