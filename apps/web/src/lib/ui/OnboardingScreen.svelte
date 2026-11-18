<script lang="ts">
  import { ArrowRight } from "@lucide/svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";

  /** No networking here. App owns synthetic organization creation. */
  export let organizationName: string;
  export let onOrganizationNameChange: (value: string) => void;
  export let onCreateOrganization: () => void;
</script>

          <div class="welcome-grid atelier-welcome">
            <div class="welcome-copy">
              <div class="welcome-introline">
                <span class="welcome-brand">kuki / STUDIO</span>
                <span class="welcome-edition">Практика красивого сервиса</span>
              </div>
              <div class="welcome-illustration" aria-hidden="true">
                <span class="welcome-arc one"></span>
                <span class="welcome-arc two"></span>
                <span class="welcome-arc three"></span>
                <span class="welcome-illustration-core"></span>
              </div>
              <h1>Красивый сервис<br /><span>начинается здесь.</span></h1>
              <p>Записи, специалисты и расписание — в одном понятном пространстве. Попробуйте kuki с демонстрационными данными.</p>
              <div class="welcome-caption">
                <span class="welcome-caption-line" aria-hidden="true"></span>
                <span>Один салон. Сотни деталей. Один спокойный процесс.</span>
              </div>
            </div>
            <form class="welcome-form card" onsubmit={(event) => { event.preventDefault(); onCreateOrganization(); }}>
              <div class="welcome-form-top">
                <span>Ваше пространство</span>
                <span class="welcome-form-step">01 / 05</span>
              </div>
              <h2>Начнём с названия.</h2>
              <p class="muted">Создайте тестовую студию — без регистрации и без реальных клиентских данных.</p>
              <label class="field">
                Как называется салон?
                <Input
                  value={organizationName}
                  oninput={(event) => onOrganizationNameChange(event.currentTarget.value)}
                  required
                  maxlength={80}
                  placeholder="Студия kuki (тест)"
                />
              </label>
              <div class="welcome-form-help">Филиал для демо создадим автоматически. Следом добавим услуги и мастеров.</div>
              <Button class="welcome-submit" size="lg" type="submit">
                Создать тестовый салон
                <ArrowRight size={18} aria-hidden="true" />
              </Button>
              <p class="form-foot">Данные остаются в этой вкладке браузера</p>
            </form>
          </div>
