<script lang="ts">
  import { CalendarDays, Clock3, ShieldCheck, UserRound } from "@lucide/svelte";
  import * as Card from "../components/ui/card/index.js";
  import { money, shortDate } from "../dates";
  import type { Service } from "../model";

  export let service: Service | undefined;
  export let staffId: string;
  export let bookingDate: string;
  export let bookingTime: string;
  export let staffName: (id: string) => string;
</script>

<Card.Root class="booking-summary" aria-label="Сводка демо-визита">
  <div class="ticket-top">
    <div class="ticket-topline">
      <span>Cookie / ваш визит</span>
      <span class="ticket-demo">DEMO</span>
    </div>
    <div class="ticket-mark" aria-hidden="true">
      <span></span><span></span><span></span><span></span>
    </div>
    <h2>Время, которое<br />принадлежит вам.</h2>
    <p>Ваш маленький план на красивый день.</p>
  </div>
  <div class="ticket-stitch" aria-hidden="true"></div>
  <div class="ticket-body">
    <div class="ticket-service">
      <span>Выбранная услуга</span>
      <strong>{service?.name ?? "Ожидает выбора"}</strong>
      <small>{service ? `${service.durationMinutes} минут` : "Выберите услугу слева"}</small>
    </div>
    <dl class="ticket-details">
      <div>
        <dt><UserRound size={15} aria-hidden="true" /> Специалист</dt>
        <dd>{staffId ? staffName(staffId) : "—"}</dd>
      </div>
      <div>
        <dt><CalendarDays size={15} aria-hidden="true" /> День</dt>
        <dd>{bookingDate ? shortDate(bookingDate) : "—"}</dd>
      </div>
      <div>
        <dt><Clock3 size={15} aria-hidden="true" /> Начало</dt>
        <dd>{bookingTime || "—"}</dd>
      </div>
    </dl>
    <div class="ticket-total">
      <div>
        <span>По каталогу</span>
        <small>Предварительная цена</small>
      </div>
      <strong>{service ? money(service.basePriceRub) : "—"}</strong>
    </div>
    <div class="ticket-fineprint">
      <ShieldCheck size={16} aria-hidden="true" />
      <p>Это не окончательная стоимость. Цена и свободное время будут подтверждаться сервером.</p>
    </div>
  </div>
</Card.Root>
