<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "../components/ui/button/index.js";
  import { Input } from "../components/ui/input/index.js";
  import { Label } from "../components/ui/label/index.js";
  import {
    completeEmailCredentialLink,
    completeEmailPasswordRecovery,
    completeEmailRegistration,
    completeTelegramOidc,
    createOwnerWorkspace,
    discoverAuthMethods,
    enrollCustomer,
    IdentityAuthFailure,
    listIdentityOrganizations,
    listIdentityProviders,
    loginEmailPassword,
    loginTelegramMiniApp,
    linkTelegramMiniApp,
    logoutIdentitySession,
    persistBrowserIdentitySession,
    restoreBrowserIdentitySession,
    watchBrowserIdentitySession,
    restoreWorkspaceContext,
    requestEmailCredentialLink,
    requestEmailPasswordRecovery,
    requestEmailRegistration,
    selectTelegramTransport,
    startTelegramOidc,
    verifyOwnerWorkspaceSession,
    verifyStagingCustomerSession,
    type AuthMethods,
    type IdentityAuthSession,
    type IdentityOrganization,
    type IdentityProviders,
  } from "../identity-auth.js";
  import {
    loadTelegramInitData,
    readTelegramInitData,
    watchOwnerSessionExpiry,
    type VerifiedCustomerSession,
    type VerifiedOwnerSession,
  } from "../owner-auth.js";

  import { isLogoutPending, readWorkspaceHint, writeLogoutPending, writeWorkspaceHint } from "../workspace-hint";
  import { withBrowserLogin } from "../browser-login-order.js";

  export let customerSurface = false;
  export let customerTenantId = "";
  export let authNotice = "";
  export let initialIdentitySession: IdentityAuthSession | null = null;
  export let restoreAllowed = true;
  export let onOwnerSession: (session: VerifiedOwnerSession) => void;
  export let onCustomerSession: (session: VerifiedCustomerSession) => void;

  type Role = "business" | "customer";
  type Page =
    | "choose-role"
    | "login"
    | "register"
    | "email-sent"
    | "registration-complete"
    | "recovery-request"
    | "recovery-complete";

  let page: Page = customerSurface ? "login" : "choose-role";
  let role: Role | null = customerSurface ? "customer" : null;
  let methods: AuthMethods | null = null;
  let telegramInitData: string | null = null;
  $: telegramTransport = selectTelegramTransport(methods, telegramInitData !== null);
  let identitySession: IdentityAuthSession | null = null;
  let providers: IdentityProviders | null = null;
  let organizations: IdentityOrganization[] = [];
  let methodsLoading = true;
  let accountLoading = false;
  let accountLoaded = false;
  let busy = false;
  let signingOut = false;
  let email = "";
  let password = "";
  let newPassword = "";
  let recoveryToken = "";
  let registrationToken = "";
  let emailLinkToken = "";
  let emailLinkPassword = "";
  let tenantId = customerTenantId;
  let consentConfirmed = false;
  let organizationName = "";
  let locationName = "";
  let timeZone = "";
  let timeZoneOptions: { id: string; utcOffset: string }[] = [];
  let linkEmail = "";
  let error = "";
  let notice = authNotice;
  $: if (authNotice) notice = authNotice;
  let emailLinkRequested = false;
  let stopIdentityExpiry: (() => void) | null = null;
  let stopBrowserWatch: (() => void) | null = null;
  let workspaceRetry: {
    key: string;
    organizationName: string;
    locationName: string;
    timeZone: string;
  } | null = null;

  $: ownerOrganizations = organizations.filter((organization) =>
    organization.roleTypes.includes("owner") ||
    organization.roleTypes.includes("admin"),
  );

  $: customerOrganizations = organizations.filter((organization) =>
    organization.roleTypes.includes("client") &&
    (!customerSurface || !customerTenantId || organization.tenantId === customerTenantId),
  );

  function clearUrlSecret(): void {
    const current = new URL(window.location.href);
    current.hash = "";
    current.searchParams.delete("code");
    current.searchParams.delete("state");
    window.history.replaceState(window.history.state, "", current.pathname + current.search);
  }

  function errorMessage(reason: unknown): string {
    if (reason instanceof IdentityAuthFailure) {
      if (reason.reason === "unauthorized") return "Не удалось подтвердить вход. Проверьте данные и попробуйте снова.";
      if (reason.reason === "invalid-request") return "Проверьте поля формы и попробуйте снова.";
      if (reason.reason === "workspace-conflict") return "Для этой операции уже существует другая рабочая область. Обновите страницу и проверьте список организаций.";
      if (reason.reason === "registration-pending") return "Проверьте почту и завершите регистрацию по ссылке из письма.";
    }
    return "Сервер недоступен или не подтвердил действие. Попробуйте ещё раз.";
  }

  function utcOffsetLabel(timeZoneId: string): string {
    const offset = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZoneId,
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    return offset === "GMT" ? "UTC+00:00" : offset.replace(/^GMT/, "UTC");
  }

  async function refreshAccount(): Promise<void> {
    const current = identitySession;
    if (!current || accountLoading) return;
    const requestIdentity: IdentityAuthSession = current;
    accountLoaded = false;
    accountLoading = true;
    error = "";
    // An early 503 must not hide a later authoritative 401 from the
    // other parallel account read. Never revoke a newer Identity.
    function observe<T>(request: Promise<T>): Promise<T> {
      return request.catch((reason: unknown) => {
        if (
          reason instanceof IdentityAuthFailure &&
          reason.reason === "unauthorized"
        ) {
          invalidateIdentity(requestIdentity, "Сессия завершилась. Войдите снова.");
        }
        throw reason;
      });
    }
    try {
      const [linkedProviders, memberships] = await Promise.all([
        observe(listIdentityProviders(current)),
        observe(listIdentityOrganizations(current)),
      ]);
      if (identitySession !== current) return;
      providers = linkedProviders;
      organizations = memberships;
      accountLoaded = true;
    } catch {
      if (identitySession !== current) return;
      error = "Вход подтверждён, но данные учётной записи не загрузились. Повторите загрузку.";
    } finally {
      if (identitySession === current) accountLoading = false;
    }
  }

  function invalidateIdentity(session: IdentityAuthSession, message: string): void {
    if (identitySession !== session) return;
    stopIdentityExpiry?.();
    stopBrowserWatch?.();
    identitySession = null;
    writeWorkspaceHint(window.history, null);
    accountLoading = false;
    accountLoaded = false;
    providers = null;
    organizations = [];
    workspaceRetry = null;
    error = "";
    role = customerSurface ? "customer" : null;
    page = role ? "login" : "choose-role";
    notice = message;
  }

  function acceptIdentity(session: IdentityAuthSession): Promise<void> {
    stopIdentityExpiry?.();
    stopBrowserWatch?.();
    identitySession = session;
    accountLoading = false;
    accountLoaded = false;
    providers = null;
    organizations = [];
    notice = initialIdentitySession && authNotice ? authNotice : "Вход подтверждён. Выберите, как пользоваться kuki.";
    stopBrowserWatch = watchBrowserIdentitySession(session, () => invalidateIdentity(session, "Сессия в браузере изменилась или завершилась. Войдите снова."), window, document);
    stopIdentityExpiry = watchOwnerSessionExpiry(
      session.expiresAtUnixSeconds,
      () => invalidateIdentity(session, "Срок действия входа истёк. Войдите снова."),
      window,
      document,
    );
    return refreshAccount();
  }

  async function acceptNewIdentity(session: IdentityAuthSession, canPersist: boolean): Promise<void> {
    // Block restoration of an older cookie unless this exact bind is confirmed.
    writeLogoutPending(window.history, true);
    let persisted = false;
    if (canPersist) {
      try {
        await persistBrowserIdentitySession(session);
        persisted = true;
        writeLogoutPending(window.history, false);
      } catch {
        // Authentication remains valid in this tab, but persistence is not proven.
      }
    }
    void acceptIdentity({ ...session, browserBound: persisted });
    if (!persisted) notice = "Вход подтверждён только для этой вкладки. При обновлении войдите снова.";
  }

  async function restoreIdentity(resume = false): Promise<void> {
    if (!initialIdentitySession && isLogoutPending(window.history)) {
      notice = "Предыдущая сессия не подтверждена. Автоматическое восстановление отключено. Войдите снова.";
      return;
    }
    busy = true;
    // Consume the tab's hint once. Only a verified workspace writes it again.
    const hint = resume && !initialIdentitySession ? readWorkspaceHint(window.history) : null;
    writeWorkspaceHint(window.history, null);
    try {
      if (initialIdentitySession) {
        await acceptIdentity(initialIdentitySession);
      } else {
        // Hold the same origin-wide lock through account and hinted-workspace
        // acceptance, not only the cookie GET. A newer explicit login must not
        // bind a different cookie between restoration and using this identity.
        await withBrowserLogin(window, async (canPersist) => {
          if (!canPersist) return;
          const restored = await restoreBrowserIdentitySession();
          if (!restored) return;
          const current = { ...restored, browserBound: true };
          await acceptIdentity(current);
          if (!hint || identitySession !== current || !accountLoaded) return;
          // Explicit customer links take precedence over this tab's previous role.
          if (customerSurface && (hint.role !== "customer" || (customerTenantId && hint.tenantId !== customerTenantId))) return;
          try {
            const context = await restoreWorkspaceContext(current, hint, organizations);
            if (identitySession !== current) return;
            if (context.role === "business") onOwnerSession(context.session);
            else onCustomerSession(context.session);
          } catch {
            if (identitySession === current) notice = "Предыдущий кабинет недоступен. Выберите доступную организацию.";
          }
        });
      }
    } catch (reason) {
      error = errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function finishTelegramReturn(code: string, state: string): Promise<void> {
    busy = true;
    error = "";
    clearUrlSecret();
    try {
      await withBrowserLogin(window, async (canPersist) =>
        acceptNewIdentity(await completeTelegramOidc(code, state), canPersist));
    } catch (reason) {
      if (reason instanceof IdentityAuthFailure && reason.reason === "unavailable") {
        error = "kuki не смог завершить вход через Telegram. Начните вход заново.";
      } else {
        error = errorMessage(reason);
      }
      page = "login";
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const browserTimeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const supportedTimeZones =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : [browserTimeZone, "UTC"]; // shortcut: older browsers get only local zone and UTC; bundle IANA data if they become supported targets.
    timeZoneOptions = [
      ...new Set([browserTimeZone, "UTC", ...supportedTimeZones]),
    ]
      .map((id) => ({ id, utcOffset: utcOffsetLabel(id) }));
    if (!timeZone) timeZone = browserTimeZone;
    const url = new URL(window.location.href);
    const hash = new URLSearchParams(url.hash.slice(1));
    void discoverAuthMethods()
      .then(async (result) => {
        methods = result;
        if (!result.telegramMiniApp) return;
        // Launch metadata only tells us whether to load the official bridge.
        telegramInitData = readTelegramInitData(window);
        if (!telegramInitData && hash.has("tgWebAppPlatform")) {
          telegramInitData = await loadTelegramInitData(window, document);
        }
      })
      .catch((reason) => (error = errorMessage(reason)))
      .finally(() => (methodsLoading = false));

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const proof = hash.get("token") ?? "";
    if (url.pathname.endsWith("/auth/telegram/callback") && code && state) {
      void finishTelegramReturn(code, state);
    } else if (url.pathname.endsWith("/register")) {
      registrationToken = proof;
      page = proof ? "registration-complete" : "register";
    } else if (url.pathname.endsWith("/recover")) {
      recoveryToken = proof;
      page = proof ? "recovery-complete" : "recovery-request";
    } else if (url.pathname.endsWith("/link-email")) {
      emailLinkToken = proof;
      if (restoreAllowed) void restoreIdentity();
    } else if (restoreAllowed) {
      void restoreIdentity(true);
    }

    return () => {
      stopIdentityExpiry?.();
      stopBrowserWatch?.();
      stopIdentityExpiry = null;
    };
  });

  async function submitEmailLogin(): Promise<void> {
    busy = true;
    error = "";
    try {
      await withBrowserLogin(window, async (canPersist) =>
        acceptNewIdentity(await loginEmailPassword(email, password), canPersist));
      password = "";
    } catch (reason) {
      error = errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function submitRegistrationRequest(): Promise<void> {
    busy = true;
    error = "";
    try {
      await requestEmailRegistration(email);
      page = "email-sent";
      notice = "Если адрес можно зарегистрировать и почтовый сервис настроен, на него придёт письмо со ссылкой.";
    } catch (reason) {
      error = errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function submitRegistration(): Promise<void> {
    if ([...newPassword].length < 15) {
      error = "Пароль должен содержать не менее 15 символов.";
      return;
    }
    busy = true;
    error = "";
    try {
      await completeEmailRegistration(registrationToken, newPassword);
      clearUrlSecret();
      registrationToken = "";
      newPassword = "";
      page = "login";
      notice = "Email подтверждён. Теперь войдите с адресом и паролем.";
    } catch (reason) {
      error = errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function submitRecoveryRequest(): Promise<void> {
    busy = true;
    error = "";
    try {
      await requestEmailPasswordRecovery(email);
      notice = "Если для адреса есть аккаунт, письмо для восстановления будет отправлено.";
    } catch (reason) {
      error = errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function submitPasswordRecovery(): Promise<void> {
    if ([...newPassword].length < 15) {
      error = "Пароль должен содержать не менее 15 символов.";
      return;
    }
    busy = true;
    error = "";
    try {
      await completeEmailPasswordRecovery(recoveryToken, newPassword);
      clearUrlSecret();
      recoveryToken = "";
      newPassword = "";
      page = "login";
      notice = "Пароль изменён. Войдите с новым паролем.";
    } catch (reason) {
      error = errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function telegramLogin(intent: "login" | "register"): Promise<void> {
    busy = true;
    error = "";
    try {
      if (!telegramInitData) throw new IdentityAuthFailure("unauthorized");
      const proof = telegramInitData;
      await withBrowserLogin(window, async (canPersist) => {
        const result = await loginTelegramMiniApp(proof, intent);
        if ("tenantId" in result) {
          if (role === "customer") {
            const customer = await verifyStagingCustomerSession(result);
            onCustomerSession(customer);
          } else {
            onOwnerSession(await verifyOwnerWorkspaceSession(result));
          }
        } else {
          await acceptNewIdentity(result, canPersist);
        }
      });
    } catch (reason) {
      error = errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function telegramWebLogin(intent: "login" | "register"): Promise<void> {
    busy = true;
    error = "";
    try {
      const authorizationUrl = await startTelegramOidc(intent);
      window.location.assign(authorizationUrl);
    } catch (reason) {
      error = errorMessage(reason);
      busy = false;
    }
  }

  async function requestEmailLink(): Promise<void> {
    if (!identitySession) return;
    busy = true;
    error = "";
    try {
      await requestEmailCredentialLink(identitySession, linkEmail);
      emailLinkRequested = true;
      linkEmail = "";
      notice = "Если email можно привязать, письмо со ссылкой придёт на этот адрес.";
    } catch (reason) {
      error = errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function completeEmailLink(): Promise<void> {
    const current = identitySession;
    if (!current) return;
    if ([...emailLinkPassword].length < 15) {
      error = "Пароль должен содержать не менее 15 символов.";
      return;
    }
    busy = true;
    error = "";
    try {
      await completeEmailCredentialLink(current, emailLinkToken, emailLinkPassword);
      if (identitySession !== current) return;
      clearUrlSecret();
      emailLinkToken = "";
      emailLinkPassword = "";
      await refreshAccount();
      if (identitySession === current && accountLoaded)
        notice = "Email привязан к этой учётной записи.";
    } catch (reason) {
      error = errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function linkTelegramMiniAppNow(): Promise<void> {
    const current = identitySession;
    if (!current) return;
    busy = true;
    error = "";
    try {
      if (!telegramInitData) throw new IdentityAuthFailure("unauthorized");
      await linkTelegramMiniApp(current, telegramInitData);
      if (identitySession !== current) return;
      await refreshAccount();
      if (identitySession === current && accountLoaded)
        notice = "Telegram привязан к этой учётной записи.";
    } catch (reason) {
      error = errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function linkTelegramWeb(): Promise<void> {
    if (!identitySession) return;
    busy = true;
    error = "";
    try {
      const authorizationUrl = await startTelegramOidc("link", identitySession);
      window.location.assign(authorizationUrl);
    } catch (reason) {
      error = errorMessage(reason);
      busy = false;
    }
  }

  async function createWorkspace(): Promise<void> {
    const current = identitySession;
    if (!current) return;
    if (!workspaceRetry) {
      workspaceRetry = {
        key: crypto.randomUUID(),
        organizationName,
        locationName,
        timeZone,
      };
    }
    busy = true;
    error = "";
    try {
      const { key, ...workspaceInput } = workspaceRetry;
      const result = await createOwnerWorkspace(
        current,
        workspaceInput,
        key,
      );
      if (identitySession === current) onOwnerSession({ ...current, tenantId: result.tenantId });
    } catch (reason) {
      if (reason instanceof IdentityAuthFailure && reason.reason === "invalid-request") {
        workspaceRetry = null;
        error = "Проверьте названия организации и филиала; часовой пояс должен быть выбран из списка.";
      } else {
        error = errorMessage(reason);
      }
    } finally {
      busy = false;
    }
  }

  async function enterOrganization(organization: IdentityOrganization): Promise<void> {
    if (!identitySession) return;
    if (!organization.roleTypes.includes("owner") && !organization.roleTypes.includes("admin")) {
      error = "Для кабинета бизнеса нужны права владельца или администратора.";
      return;
    }
    const current = identitySession;
    busy = true;
    error = "";
    try {
      const context = await restoreWorkspaceContext(current, { role: "business", tenantId: organization.tenantId }, organizations);
      if (identitySession === current && context.role === "business") onOwnerSession(context.session);
    } catch (reason) {
      if (identitySession === current) error = errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function enterCustomerOrganization(organization: IdentityOrganization): Promise<void> {
    const current = identitySession;
    if (!current || busy || !accountLoaded) return;
    busy = true;
    error = "";
    try {
      const context = await restoreWorkspaceContext(current, { role: "customer", tenantId: organization.tenantId }, organizations);
      if (identitySession === current && context.role === "customer") onCustomerSession(context.session);
    } catch (reason) {
      if (identitySession === current) error = reason instanceof IdentityAuthFailure && reason.reason === "unauthorized"
        ? "Доступ к клиентскому кабинету не подтверждён. Выберите другой кабинет или обновите список организаций."
        : errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function enrollAsCustomer(): Promise<void> {
    const current = identitySession;
    if (!current || busy || !accountLoaded) return;
    if (!methods?.stagingCustomerEnrollment) {
      error = "Самостоятельное клиентское зачисление включается только в контролируемом staging.";
      return;
    }
    if (!consentConfirmed) {
      error = "Подтвердите согласие на создание клиентской учётной записи в тестовой организации.";
      return;
    }
    busy = true;
    error = "";
    try {
      const enrolled = await enrollCustomer(current, tenantId);
      if (identitySession !== current) return;
      // Enrollment receipt alone is not current context authorization.
      const session = await verifyStagingCustomerSession(enrolled);
      if (identitySession === current) onCustomerSession(session);
    } catch (reason) {
      error = reason instanceof IdentityAuthFailure && reason.reason === "unavailable"
        ? "Тестовое зачисление не подтверждено. Проверьте ID организации и активное разрешение staging."
        : errorMessage(reason);
    } finally {
      busy = false;
    }
  }

  async function signOutIdentity(): Promise<void> {
    const current = identitySession;
    if (!current || busy || signingOut) return;
    signingOut = true;
    writeLogoutPending(window.history, true);
    stopBrowserWatch?.();
    stopIdentityExpiry?.();
    stopIdentityExpiry = null;
    identitySession = null;
    accountLoading = false;
    accountLoaded = false;
    providers = null;
    organizations = [];
    workspaceRetry = null;
    role = customerSurface ? "customer" : null;
    page = role ? "login" : "choose-role";
    if (current) {
      try {
        await logoutIdentitySession(current);
        writeLogoutPending(window.history, false);
        notice = "Вы вышли. Серверная сессия отозвана.";
      } catch {
        notice = "Локальный вход закрыт, но сервер не подтвердил отзыв. Старая сессия может действовать до истечения срока.";
      } finally {
        signingOut = false;
      }
    }
  }

  function chooseRole(value: Role): void {
    role = value;
    error = "";
    notice = "";
    if (!accountLoaded && !accountLoading) void refreshAccount();
  }

  function beginRegistration(): void {
    page = "register";
    error = "";
    notice = "";
  }
</script>

<section class="identity-auth-page" aria-labelledby="identity-auth-title">
  <div class="identity-auth-card">
    <span class="identity-auth-overline">kuki / ПРОВЕРЕННЫЙ ВХОД</span>
    {#if signingOut}
      <h1 id="identity-auth-title">Завершаем сеанс</h1>
      <p role="status">Ожидаем подтверждение выхода от сервера.</p>
    {:else if identitySession && emailLinkToken}
      <h1 id="identity-auth-title">Подключить email</h1>
      <p>Введите пароль для нового email. Подтверждение завершится только для этой же учётной записи.</p>
      <form class="identity-auth-fields" onsubmit={(event) => { event.preventDefault(); void completeEmailLink(); }}>
        <Label for="linked-email-password">Пароль для email</Label>
        <Input id="linked-email-password" type="password" autocomplete="new-password" bind:value={emailLinkPassword} minlength={15} maxlength={1024} required />
        <Button type="submit" disabled={busy}>{busy ? "Подключаем…" : "Подтвердить email"}</Button>
      </form>
    {:else if identitySession}
      <h1 id="identity-auth-title">Настройте kuki</h1>
      <p>Одна учётная запись может использоваться для кабинета бизнеса или клиентской записи. Выберите нужный сценарий.</p>

      {#if !role}
        <div class="identity-role-options" aria-label="Тип учётной записи">
          <Button variant="outline" disabled={busy} onclick={() => chooseRole("business")}>Я представляю бизнес</Button>
          <Button variant="outline" disabled={busy || (!methods?.stagingCustomerEnrollment && !customerOrganizations.length)} onclick={() => chooseRole("customer")}>Я клиент</Button>
        </div>
        {#if !methodsLoading && !methods?.stagingCustomerEnrollment}<p>Клиентская регистрация доступна на приватной тестовой странице опубликованной организации.</p>{/if}
      {:else if role === "business"}
        <div class="identity-auth-section">
          <div class="identity-auth-section-head">
            <div><span>БИЗНЕС</span><h2>Кабинет организации</h2></div>
            {#if !customerSurface}<Button variant="ghost" onclick={() => role = null}>Сменить сценарий</Button>{/if}
          </div>
          {#if accountLoading}
            <p role="status">Проверяем организации…</p>
          {:else if !accountLoaded}
            <p role="status">Список организаций не загружен. Создание кабинета пока недоступно.</p>
          {:else if ownerOrganizations.length}
            <div class="identity-organization-list">
              {#each ownerOrganizations as organization (organization.tenantId)}
                <Button variant="outline" disabled={busy} onclick={() => void enterOrganization(organization)}>
                  <span>{organization.organizationName}</span><small>{organization.roleTypes.join(" · ")}</small>
                </Button>
              {/each}
            </div>
          {:else}
            <p>Создайте рабочую область. Первичная настройка организации и филиала сохранится на сервере.</p>
            <form class="identity-auth-fields" onsubmit={(event) => { event.preventDefault(); void createWorkspace(); }}>
              <Label for="organization-name">Название организации</Label>
              <Input id="organization-name" bind:value={organizationName} maxlength={120} required disabled={busy || workspaceRetry !== null} />
              <Label for="location-name">Первый филиал</Label>
              <Input id="location-name" bind:value={locationName} maxlength={120} required disabled={busy || workspaceRetry !== null} />
              <Label for="identity-time-zone">Часовой пояс филиала</Label>
              <select id="identity-time-zone" class="identity-time-zone-select" bind:value={timeZone} required disabled={busy || workspaceRetry !== null}>
                <option value="" disabled>Выберите часовой пояс</option>
                {#each timeZoneOptions as option (option.id)}
                  <option value={option.id}>{option.id} — {option.utcOffset}</option>
                {/each}
              </select>
              <p class="identity-time-zone-help">По умолчанию выбран часовой пояс этого устройства. Смещение в списке указано относительно UTC на текущую дату; сезонные переходы учитываются автоматически.</p>
              <Button type="submit" disabled={busy || accountLoading}>{busy ? "Сохраняем…" : workspaceRetry ? "Повторить ту же операцию" : "Создать кабинет бизнеса"}</Button>
            </form>
          {/if}
        </div>
      {:else}
        <div class="identity-auth-section">
          <div class="identity-auth-section-head">
            <div><span>КЛИЕНТСКИЙ СЦЕНАРИЙ / STAGING</span><h2>Клиентская запись</h2></div>
            {#if !customerSurface}<Button variant="ghost" onclick={() => role = null}>Сменить сценарий</Button>{/if}
          </div>
          {#if accountLoading}
            <p role="status">Проверяем организации…</p>
          {:else if !accountLoaded}
            <p role="status">Не удалось подтвердить список клиентских кабинетов.</p>
          {:else if customerOrganizations.length}
            <p>Выберите существующий клиентский кабинет.</p>
            <div class="identity-organization-list" aria-label="Клиентские организации">
              {#each customerOrganizations as organization (organization.tenantId)}
                <Button variant="outline" disabled={busy} onclick={() => void enterCustomerOrganization(organization)}>
                  <span>{organization.organizationName}</span><small>Клиент</small>
                </Button>
              {/each}
            </div>
          {/if}
          {#if methods?.stagingCustomerEnrollment && accountLoaded}
            <p>Для регистрации в новой тестовой организации введите её ID и подтвердите согласие.</p>
            <form class="identity-auth-fields" onsubmit={(event) => { event.preventDefault(); void enrollAsCustomer(); }}>
              <Label for="customer-tenant-id">ID тестовой организации</Label>
              <Input id="customer-tenant-id" bind:value={tenantId} pattern="[0-9a-fA-F-]{36}" maxlength={36} required disabled={busy} />
              <label class="identity-consent">
                <input type="checkbox" bind:checked={consentConfirmed} disabled={busy} />
                <span>Согласен создать клиентскую учётную запись в этой тестовой организации.</span>
              </label>
              <Button type="submit" disabled={busy || !consentConfirmed}>{busy ? "Проверяем…" : "Продолжить как клиент"}</Button>
            </form>
          {:else if !methods?.stagingCustomerEnrollment}
            <p role="status">Клиентское тестовое зачисление отключено на этом сервере.</p>
          {/if}
        </div>
      {/if}

      <div class="identity-auth-section identity-provider-section">
        <div class="identity-auth-section-head"><div><span>СПОСОБЫ ВХОДА</span><h2>Привязанные методы</h2></div></div>
        {#if accountLoading || methodsLoading}
          <p role="status">Загружаем способы входа…</p>
        {:else if !accountLoaded || providers === null}
          <p role="status">Вход выполнен, но данные учётной записи временно недоступны.</p>
          <Button variant="outline" disabled={busy} onclick={() => void refreshAccount()}>Повторить загрузку</Button>
        {:else}
          <ul class="identity-provider-list">
            <li><span>Email и пароль</span><strong>{providers.email ? "Подключён" : "Не подключён"}</strong></li>
            <li><span>Telegram</span><strong>{providers.telegram ? "Подключён" : "Не подключён"}</strong></li>
          </ul>
          {#if methods?.email && !providers.email}
            <form class="identity-auth-fields identity-link-email" onsubmit={(event) => { event.preventDefault(); void requestEmailLink(); }}>
              <Label for="link-email-address">Добавить email</Label>
              <Input id="link-email-address" type="email" autocomplete="email" bind:value={linkEmail} maxlength={254} required />
              <Button variant="outline" type="submit" disabled={busy}>{busy ? "Отправляем…" : "Отправить ссылку подтверждения"}</Button>
              {#if emailLinkRequested}<p role="status">Откройте ссылку из письма в этом браузере и войдите в эту учётную запись.</p>{/if}
            </form>
          {/if}
          {#if telegramTransport && !providers.telegram}
            <Button variant="outline" disabled={busy} onclick={() => void (telegramTransport === "mini-app" ? linkTelegramMiniAppNow() : linkTelegramWeb())}>Привязать Telegram</Button>
          {/if}
        {/if}
      </div>
      <Button variant="ghost" disabled={busy} onclick={() => void signOutIdentity()}>Выйти из учётной записи</Button>
    {:else if page === "choose-role"}
      <h1 id="identity-auth-title">Кто вы?</h1>
      <p>Выберите сценарий. Доступные способы входа задаются настройками сервера; после входа можно привязать другой включённый способ.</p>
      <div class="identity-role-options" aria-label="Тип учётной записи">
        <Button variant="outline" disabled={busy} onclick={() => { role = "business"; page = "login"; }}>Я представляю бизнес</Button>
        <Button variant="outline" disabled={busy || !methods?.stagingCustomerEnrollment} onclick={() => { role = "customer"; page = "login"; }}>Я клиент</Button>
      </div>
      {#if !methodsLoading && !methods?.stagingCustomerEnrollment}<p>Клиентская регистрация доступна на приватной тестовой странице опубликованной организации.</p>{/if}
    {:else if page === "registration-complete"}
      <h1 id="identity-auth-title">Завершите регистрацию</h1>
      <p>Создайте пароль не короче 15 символов. Ссылка действует ограниченное время и используется один раз.</p>
      <form class="identity-auth-fields" onsubmit={(event) => { event.preventDefault(); void submitRegistration(); }}>
        <Label for="registration-password">Новый пароль</Label>
        <Input id="registration-password" type="password" autocomplete="new-password" bind:value={newPassword} minlength={15} maxlength={1024} required />
        <Button type="submit" disabled={busy || !registrationToken}>{busy ? "Проверяем…" : "Создать учётную запись"}</Button>
      </form>
    {:else if page === "recovery-complete"}
      <h1 id="identity-auth-title">Задайте новый пароль</h1>
      <p>Введите пароль не короче 15 символов. После смены прежние сессии будут отозваны.</p>
      <form class="identity-auth-fields" onsubmit={(event) => { event.preventDefault(); void submitPasswordRecovery(); }}>
        <Label for="recovery-password">Новый пароль</Label>
        <Input id="recovery-password" type="password" autocomplete="new-password" bind:value={newPassword} minlength={15} maxlength={1024} required />
        <Button type="submit" disabled={busy || !recoveryToken}>{busy ? "Сохраняем…" : "Изменить пароль"}</Button>
      </form>
    {:else if page === "recovery-request"}
      <h1 id="identity-auth-title">Восстановление пароля</h1>
      <p>Если для адреса есть учётная запись, мы отправим письмо со ссылкой для смены пароля.</p>
      <form class="identity-auth-fields" onsubmit={(event) => { event.preventDefault(); void submitRecoveryRequest(); }}>
        <Label for="recovery-email">Email</Label>
        <Input id="recovery-email" type="email" autocomplete="email" bind:value={email} maxlength={254} required />
        <Button type="submit" disabled={busy || !methods?.email}>{busy ? "Отправляем…" : "Отправить ссылку"}</Button>
      </form>
      <Button variant="ghost" onclick={() => page = "login"}>Вернуться ко входу</Button>
    {:else if page === "email-sent"}
      <h1 id="identity-auth-title">Проверьте почту</h1>
      <p>{notice}</p>
      <Button variant="outline" onclick={() => page = "login"}>Перейти ко входу</Button>
    {:else}
      <h1 id="identity-auth-title">{page === "register" ? "Создать учётную запись" : role === "customer" ? "Вход клиента" : "Вход в kuki"}</h1>
      {#if methodsLoading}
        <p role="status">Проверяем доступные способы входа…</p>
      {:else if methods}
        {#if methods.email}
          <form class="identity-auth-fields" onsubmit={(event) => { event.preventDefault(); page === "register" ? void submitRegistrationRequest() : void submitEmailLogin(); }}>
            <Label for="identity-email">Email</Label>
            <Input id="identity-email" type="email" autocomplete="email" bind:value={email} maxlength={254} required />
            {#if page === "login"}
              <Label for="identity-password">Пароль</Label>
              <Input id="identity-password" type="password" autocomplete="current-password" bind:value={password} maxlength={1024} required />
            {/if}
            <Button type="submit" disabled={busy}>{busy ? "Подождите…" : page === "register" ? "Отправить письмо для регистрации" : "Войти по email"}</Button>
          </form>
        {/if}
        {#if telegramTransport}
          <Button variant="outline" disabled={busy} onclick={() => {
            const intent = page === "register" ? "register" : "login";
            void (telegramTransport === "mini-app" ? telegramLogin(intent) : telegramWebLogin(intent));
          }}>{page === "register" ? "Зарегистрироваться через Telegram" : "Войти через Telegram"}</Button>
        {:else if methods.telegramMiniApp}
          <p>Для входа через Telegram откройте kuki из бота.</p>
        {:else if !methods.email}
          <p role="alert">На сервере не включён ни один способ входа.</p>
        {/if}
      {/if}
      {#if page === "register"}
        <Button variant="ghost" onclick={() => page = "login"}>Уже есть учётная запись? Войти</Button>
      {:else}
        <Button variant="ghost" onclick={beginRegistration}>Создать учётную запись</Button>
        {#if methods?.email}<Button variant="ghost" onclick={() => page = "recovery-request"}>Забыли пароль?</Button>{/if}
      {/if}
      {#if !customerSurface}<Button variant="ghost" onclick={() => { page = "choose-role"; role = null; }}>Назад к выбору сценария</Button>{/if}
    {/if}

    {#if error}<p class="identity-auth-error" role="alert">{error}</p>{/if}
    {#if notice && page !== "email-sent"}<p class="identity-auth-notice" role="status">{notice}</p>{/if}
    {#if busy && page === "choose-role"}<p role="status">Завершаем вход…</p>{/if}
    <p class="identity-auth-footnote">Глобальная сессия восстанавливается до окончания её срока. Права клиента и бизнеса проверяются сервером отдельно.</p>
  </div>
</section>
