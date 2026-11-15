<script lang="ts">
  import { money, shortDate } from "../dates";
  import type { Service } from "../model";

  export let service: Service | undefined;
  export let staffId: string;
  export let bookingDate: string;
  export let bookingTime: string;
  export let staffName: (id: string) => string;
</script>

<aside class="card booking-summary" aria-label="Сводка демо-визита">
  <span class="eyebrow">ВАШ ВЫБОР</span>
  <h2>Детали визита</h2>
  <div class="summary-visual" aria-hidden="true">✳</div>
  <div class="summary-line">
    <span>Услуга</span><strong>{service?.name ?? "Не выбрана"}</strong>
  </div>
  <div class="summary-line">
    <span>Длительность</span>
    <strong>{service ? `${service.durationMinutes} мин` : "—"}</strong>
  </div>
  <div class="summary-line">
    <span>Мастер</span><strong>{staffId ? staffName(staffId) : "Не выбран"}</strong>
  </div>
  <div class="summary-line">
    <span>Дата</span><strong>{bookingDate ? shortDate(bookingDate) : "—"}</strong>
  </div>
  <div class="summary-line">
    <span>Время</span><strong>{bookingTime || "—"}</strong>
  </div>
  <div class="summary-total">
    <span>Базовая цена в каталоге</span>
    <strong>{service ? money(service.basePriceRub) : "—"}</strong>
  </div>
  <p class="summary-disclaimer">
    Не является Quote или окончательной ценой. В production сумма, права и
    свободные слоты определяются сервером.
  </p>
</aside>
