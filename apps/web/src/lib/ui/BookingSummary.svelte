<script lang="ts">
  import { ArrowUpRight, Clock3, Info, ShieldCheck } from "@lucide/svelte";
  import { Badge } from "../components/ui/badge/index.js";
  import * as Card from "../components/ui/card/index.js";
  import { Separator } from "../components/ui/separator/index.js";
  import { money, shortDate } from "../dates";
  import type { Service } from "../model";

  export let service: Service | undefined;
  export let staffId: string;
  export let bookingDate: string;
  export let bookingTime: string;
  export let staffName: (id: string) => string;
</script>

<Card.Root class="booking-summary" aria-label="Сводка демо-визита">
  <div class="booking-summary-heading">
    <div>
      <span class="eyebrow">ВАША ЗАПИСЬ</span>
      <h2>Детали визита</h2>
    </div>
    <Badge variant="outline" class="booking-demo-label">Демо</Badge>
  </div>

  <div class="summary-service">
    <div class="summary-service-icon" aria-hidden="true"><Clock3 size={19} /></div>
    <div>
      <strong>{service?.name ?? "Выберите услугу"}</strong>
      <small>{service ? `${service.durationMinutes} минут` : "Услуга пока не выбрана"}</small>
    </div>
    <ArrowUpRight size={18} aria-hidden="true" class="summary-service-arrow" />
  </div>

  <div class="summary-details">
    <div class="summary-line"><span>Мастер</span><strong>{staffId ? staffName(staffId) : "Не выбран"}</strong></div>
    <div class="summary-line"><span>Дата</span><strong>{bookingDate ? shortDate(bookingDate) : "—"}</strong></div>
    <div class="summary-line"><span>Время</span><strong>{bookingTime || "Не выбрано"}</strong></div>
  </div>

  <Separator class="booking-summary-separator" />
  <div class="summary-price">
    <div>
      <span>Базовая цена</span>
      <small>По каталогу салона</small>
    </div>
    <strong>{service ? money(service.basePriceRub) : "—"}</strong>
  </div>
  <div class="summary-security">
    <ShieldCheck size={16} aria-hidden="true" />
    <span>Цена указана для примера и не является окончательной стоимостью.</span>
  </div>
  <p class="summary-disclaimer">
    <Info size={13} aria-hidden="true" />
    Итоговую стоимость и доступность времени подтвердит backend.
  </p>
</Card.Root>
