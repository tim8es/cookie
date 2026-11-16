<script lang="ts">
  import { AlertTriangle, ArrowRight, Building2, LockKeyhole, SearchX } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import * as Card from "../components/ui/card/index.js";

  export let kind: "error" | "forbidden" | "empty" | "setup";
  export let onPrimary: () => void;

  $: title = kind === "error" ? "Демо: ошибка загрузки"
    : kind === "forbidden" ? "Демо: недостаточно прав"
    : kind === "empty" ? "Демо: ничего не найдено"
    : "Сначала создайте тестовый салон";
  $: description = kind === "error" ? "Пример состояния при недоступном API. Изменения не выполнялись."
    : kind === "forbidden" ? "Эту операцию должен разрешать backend с учётом роли и филиала. Здесь только UX-состояние."
    : kind === "empty" ? "Здесь будет сообщение о пустом списке, доступном действии и способе вернуться назад."
    : "После этого откроются услуги, команда, графики и календарь.";
  $: action = kind === "error" ? "Повторить просмотр"
    : kind === "forbidden" ? "Вернуться"
    : kind === "empty" ? "Показать данные"
    : "К созданию салона";
</script>

<Card.Root class="state-card feedback-state" role={kind === "error" ? "alert" : "status"}>
  <div class="feedback-icon" aria-hidden="true">
    {#if kind === "error"}<AlertTriangle size={27}/>
    {:else if kind === "forbidden"}<LockKeyhole size={27}/>
    {:else if kind === "empty"}<SearchX size={27}/>
    {:else}<Building2 size={27}/>{/if}
  </div>
  <span class="feedback-overline">COOKIE / ДЕМОНСТРАЦИЯ</span>
  <h2>{title}</h2>
  <p>{description}</p>
  <Button type="button" size="lg" class="feedback-action" onclick={onPrimary}>
    {action} <ArrowRight size={17} aria-hidden="true"/>
  </Button>
</Card.Root>
