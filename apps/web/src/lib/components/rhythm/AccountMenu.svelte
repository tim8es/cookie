<script lang="ts">
  import type { AccountOption } from "./contracts.js";
  import Modal from "./Modal.svelte";
  import ChoiceRow from "./ChoiceRow.svelte";
  import Avatar from "./Avatar.svelte";
  import ActionButton from "./ActionButton.svelte";

  let {
    label,
    accounts,
    current,
    onSelect,
    onProfile,
    onLogout,
  }: {
    label: string;
    accounts: readonly AccountOption[];
    current: string;
    onSelect: (id: string) => void;
    onProfile?: () => void;
    onLogout?: () => void;
  } = $props();

  let open = $state(false);
</script>

<div data-component="AccountMenu">
  <Modal bind:open layout="dialog" title="Аккаунт" description="Выберите рабочее пространство или профиль." triggerLabel={label}>
    <div class="rhythm-stack">
      {#each accounts as account (account.id)}
        <ChoiceRow
          title={account.title}
          description={account.subtitle}
          selected={current === account.id}
          disabled={account.disabled}
          variant="option"
          onSelect={() => { open = false; onSelect(account.id); }}
        >
          {#snippet leading()}<Avatar initials={account.initials} imageSrc={account.imageSrc} />{/snippet}
        </ChoiceRow>
      {/each}
      {#if onProfile}<ActionButton onclick={() => { open = false; onProfile?.(); }}>Настройки профиля</ActionButton>{/if}
      {#if onLogout}<ActionButton tone="danger" onclick={() => { open = false; onLogout?.(); }}>Выйти</ActionButton>{/if}
    </div>
  </Modal>
</div>
